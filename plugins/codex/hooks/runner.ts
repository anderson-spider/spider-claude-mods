import { argsOf } from './args'
import { eventReader } from './events'
import type { Job, OutputDeps, Outcome, Request, RunResult, Spawn } from './model'
import { imagesBefore, saveAnswer, saveImages } from './output'
import { errorText, jobMessage, jobsReport, movedToBackground } from './presentation'

/** A Codex process on its way: `done` settles with its result (never rejects); `stop` kills it. */
export type Running = { done: Promise<RunResult>; stop(): void; threadId(): string | undefined }

/** Starts `argv` in `cwd` (the session's folder when absent) and reads its events until it ends. */
export function launch(spawn: Spawn, argv: string[], cwd: string | undefined): Running {
  const reader = eventReader()
  let child: ReturnType<Spawn> | undefined
  const done = (async (): Promise<RunResult> => {
    try {
      child = spawn(argv, cwd)
      for (;;) {
        const step = await child.next()
        // A stream closed from this side (stop) ends without an exit status.
        if (step.done) return reader.end(step.value ?? { code: null, signal: 'SIGTERM' })
        reader.push(step.value.stream, step.value.text)
      }
    } catch (error) {
      return { threadId: reader.threadId, error: `Codex could not run: ${errorText(error)}` }
    }
  })()
  return {
    done,
    stop: () => void child?.return(undefined as never).catch(() => undefined),
    threadId: () => reader.threadId,
  }
}

/**
 * Waits up to `ms` for `done`; undefined when the time runs out first. The wait goes through `sleep`, a host process,
 * in steps of a minute at most: a hook's own clock stops while a host call is in flight, as it would not for a timer.
 */
export async function within<T>(done: Promise<T>, ms: number, sleep: (ms: number) => Promise<unknown>, now = Date.now): Promise<T | undefined> {
  const deadline = now() + ms
  const settled = done.then(value => ({ value }))
  for (;;) {
    const left = deadline - now()
    if (left <= 0) return undefined
    const first = await Promise.race([settled, sleep(Math.min(left, 60_000)).then(() => undefined)])
    if (first) return first.value
  }
}

export type RunnerDeps = {
  spawn: Spawn
  sleep(ms: number): Promise<unknown>
  output: OutputDeps
  /** The `codex` executable, or why there is none. */
  codex(): Promise<string | { error: string }>
  /** Where an image run starts: an empty folder of the plugin's, away from any repository. */
  imageCwd: string
  toast(text: string): void
  submit(text: string): Promise<unknown>
  now?: () => number
}

export type Limits = { foregroundMs: number; backgroundMs: number }

const minutesOf = (ms: number) => Math.round(ms / 60_000)

/** The session's runs: each call brings the host access it runs with (a job keeps its own), the jobs list is shared. */
export function createRunner(limits: () => Limits) {
  const jobs: Job[] = []
  let nextJob = 1

  type Started = { running: Running; finish(result: RunResult): Promise<Outcome>; startedAt: number }

  async function start(deps: RunnerDeps, request: Request): Promise<Started | Outcome> {
    const now = deps.now ?? Date.now
    const codex = await deps.codex()
    if (typeof codex !== 'string') return { ok: false, text: codex.error, error: codex.error }
    const image = request.kind === 'image'
    // A follow-up's image folder already holds the earlier images: only the new ones are this run's.
    const before = image ? await imagesBefore(deps.output, request.threadId) : new Set<string>()
    if (image) await deps.output.run(['mkdir', '-p', deps.imageCwd])
    // An ask runs where the session does (the child's default folder); an image run in the plugin's empty folder.
    const cwd = image ? deps.imageCwd : undefined
    const running = launch(deps.spawn, [codex, ...argsOf(request, cwd)], cwd)
    const finish = (result: RunResult) => (image ? saveImages(deps.output, result, request, before) : saveAnswer(deps.output, result, request))
    return { running, finish, startedAt: now() }
  }

  // Keeps a started run as a background job: past the background limit it is stopped; its end sends a notice.
  function adopt(deps: RunnerDeps, request: Request, started: Started): Job {
    const now = deps.now ?? Date.now
    const job: Job = { id: nextJob++, kind: request.kind, prompt: request.prompt, status: 'running', startedAt: started.startedAt, threadId: started.running.threadId() }
    jobs.push(job)
    void (async () => {
      const { backgroundMs } = limits()
      let result = await within(started.running.done, Math.max(0, started.startedAt + backgroundMs - now()), deps.sleep, now).catch(
        (error): RunResult => {
          started.running.stop()
          return { threadId: started.running.threadId(), error: `The wait for Codex failed, so the run was stopped: ${errorText(error)}` }
        },
      )
      if (!result) {
        started.running.stop()
        const error = `Codex did not finish within ${minutesOf(backgroundMs)} min; the run was stopped.`
        result = { threadId: started.running.threadId(), error, timedOut: true }
      }
      const outcome = await started.finish(result).catch(error => ({ ok: false, text: errorText(error), error: errorText(error) }) as Outcome)
      job.status = outcome.ok ? 'done' : 'failed'
      job.endedAt = now()
      job.threadId = outcome.threadId ?? started.running.threadId()
      job.paths = outcome.paths
      deps.toast(`Codex job #${job.id} ${job.status}`)
      // A submitted prompt is a new turn that reaches the model like the person's words: send only the
      // automated notice, with paths and the thread, never the answer (unverified Codex output).
      await deps.submit(jobMessage(job, outcome)).catch(() => undefined)
    })()
    return job
  }

  /** Runs a request in the foreground; past the foreground wait it goes on as a background job. */
  async function runNow(deps: RunnerDeps, request: Request): Promise<Outcome> {
    const started = await start(deps, request)
    if (!('running' in started)) return started
    const { foregroundMs } = limits()
    const result = await within(started.running.done, foregroundMs, deps.sleep, deps.now)
    if (result) return started.finish(result)
    return movedToBackground(adopt(deps, request, started), minutesOf(foregroundMs))
  }

  /** Starts a request as a background job at once, or answers why it could not start. */
  async function startJob(deps: RunnerDeps, request: Request): Promise<Job | Outcome> {
    const started = await start(deps, request)
    return 'running' in started ? adopt(deps, request, started) : started
  }

  return { runNow, startJob, report: (now = Date.now()) => jobsReport(jobs, now) }
}
