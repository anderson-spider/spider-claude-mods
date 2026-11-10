import { argsOf } from './args'
import { answerPath } from './detached'
import { eventReader } from './events'
import type { Exit, Job, JobStore, OutputDeps, Outcome, Request, RunFiles, RunResult } from './model'
import { imagesBefore, saveAnswer, saveImages } from './output'
import { errorText, jobMessage, jobsReport, movedToBackground } from './presentation'

// How often a run's folder is read while it runs, how many reads go by between checks that its process is still there
// (a `ps`, so a run killed without an exit status is found well before its limit), and between the heartbeats that
// tell other sessions it is watched. A job not seen for STALE_MS has no watcher: its session ended, or changed id
// (`/clear`), and the next session to start takes it over.
const POLL_MS = 2_000
const ALIVE_EVERY = 5
const HEARTBEAT_EVERY = 10
const STALE_MS = 60_000

// Finished jobs are kept a week, and at most this many jobs in all.
const KEEP_MS = 7 * 24 * 60 * 60_000
const KEEP_JOBS = 50

// What a job keeps of its prompt: enough for the file name and the jobs list, and small in a store of 4 MiB in all.
const PROMPT_KEPT = 200

const KEY = 'job:'
const keyOf = (id: string) => `${KEY}${id}`

export type RunnerDeps = {
  files: RunFiles
  store: JobStore
  sessionId(): Promise<string>
  /** The session's folder: jobs are listed and taken over within one project. */
  project(): Promise<string>
  /** Where each run gets its folder: `$TMPDIR/codex/runs`. */
  runsDir: string
  sleep(ms: number): Promise<unknown>
  output: OutputDeps
  /** The `codex` executable, or why there is none. */
  codex(): Promise<string | { error: string }>
  /** Where an image run starts: an empty folder of the plugin's, away from any repository. */
  imageCwd: string
  toast(text: string): void
  submit(text: string): Promise<unknown>
  now?: () => number
  newId?: () => string
}

export type Limits = { foregroundMs: number; backgroundMs: number }

const minutesOf = (ms: number) => Math.round(ms / 60_000)

const LOST = 'Codex stopped before an answer that could be recovered; ask on the thread to go on.'

// An id no other session's job shares: the time, then a random suffix.
const freshId = (now: number) => `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`

// The exit status the run's shell wrote: past 128, the signal that ended it (143 is SIGTERM, 137 SIGKILL).
const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' }
const exitOf = (status: number): Exit => (status > 128 ? { code: null, signal: SIGNALS[status - 128] ?? `signal ${status - 128}` } : { code: status, signal: null })

const isJob = (value: unknown): value is Job =>
  typeof value === 'object' && value !== null && typeof (value as Job).id === 'string' && typeof (value as Job).dir === 'string'

/** What a job keeps of its request: the images and files went to Codex already, and the prompt is cut short. */
const kept = (request: Request): Request => ({ ...request, prompt: request.prompt.slice(0, PROMPT_KEPT), images: [], files: [] })

/** What a run is doing now, read from its folder. */
type Seen = { ended: RunResult } | { running: string | undefined } | { gone: true }

/** Why a watch let go of its job: another watcher owns it now, or its wait failed (a reload took the host away). */
type Released = 'released'

/**
 * Every run, foreground or background, in `$.store` and a detached process: the jobs outlive a plugin reload (the
 * session's watch on them starts again in `resume`) and the session (the next one to start takes them over).
 */
export function createRunner(limits: () => Limits) {
  const nowOf = (deps: RunnerDeps) => (deps.now ?? Date.now)()
  const save = (deps: RunnerDeps, job: Job) => deps.store.set(keyOf(job.id), job)
  const stored = async (deps: RunnerDeps, id: string) => {
    const value = await deps.store.get(keyOf(id))
    return isJob(value) ? value : undefined
  }

  async function seen(deps: RunnerDeps, job: Job): Promise<Seen> {
    const state = await deps.files.read(job.dir)
    if (!state) return { gone: true }
    const reader = eventReader()
    reader.push('stdout', `${state.head}\n`)
    if (state.exit === undefined) return { running: reader.threadId }
    // The end of the events may start mid-line: that piece is not JSON and is skipped.
    reader.push('stdout', `${state.tail ?? ''}\n`)
    // `-o` holds the last message whatever the events' size; it counts as the run's last agent message.
    if (state.answer?.trim()) reader.push('stdout', `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: state.answer } })}\n`)
    reader.push('stderr', state.stderr ?? '')
    return { ended: reader.end(exitOf(state.exit)) }
  }

  /**
   * Waits for the run until `deadline`: its result, undefined when the time runs out first, or `released` when another
   * watcher took the job over. A run whose process or folder is gone without an exit status ends as lost; one that
   * ended between a read and the process check is read once more first. The thread is saved as soon as it starts, so
   * a lost run's answer can be looked for, and a heartbeat tells other sessions the job is watched. A failing `sleep`
   * rejects.
   */
  async function waitFor(deps: RunnerDeps, job: Job, deadline: number, token?: string): Promise<RunResult | 'lost' | Released | undefined> {
    for (let reads = 1; ; reads++) {
      const now = await seen(deps, job)
      if ('ended' in now) return now.ended
      if ('gone' in now) return 'lost'
      if (reads % ALIVE_EVERY === 0 && !(await deps.files.alive(job.dir))) {
        const again = await seen(deps, job)
        return 'ended' in again ? again.ended : 'lost'
      }
      const thread = now.running && now.running !== job.threadId
      if (thread || reads % HEARTBEAT_EVERY === 0) {
        if (token !== undefined && (await stored(deps, job.id))?.watcher !== token) return 'released'
        job.threadId = now.running ?? job.threadId
        job.seenAt = nowOf(deps)
        await save(deps, job)
      }
      const left = deadline - nowOf(deps)
      if (left <= 0) return undefined
      await deps.sleep(Math.min(left, POLL_MS))
    }
  }

  async function start(deps: RunnerDeps, request: Request, background: boolean): Promise<Job | Outcome> {
    const codex = await deps.codex()
    if (typeof codex !== 'string') return { ok: false, text: codex.error, error: codex.error }
    const image = request.kind === 'image'
    // A follow-up's image folder already holds the earlier images: only the new ones are this run's.
    const before = image ? await imagesBefore(deps.output, request.threadId) : new Set<string>()
    if (image) await deps.output.run(['mkdir', '-p', deps.imageCwd])
    // An ask or review runs where the session does; an image run in the plugin's empty folder.
    const cwd = image ? deps.imageCwd : undefined
    const startedAt = nowOf(deps)
    const id = deps.newId?.() ?? freshId(startedAt)
    const dir = `${deps.runsDir}/${id}`
    const job: Job = {
      id,
      kind: request.kind,
      prompt: request.prompt.slice(0, PROMPT_KEPT),
      status: 'running',
      startedAt,
      sessionId: await deps.sessionId(),
      project: await deps.project(),
      seenAt: startedAt,
      dir,
      background,
      request: kept(request),
      before: [...before],
    }
    await save(deps, job)
    try {
      await deps.files.launch(dir, [codex, ...argsOf(request, cwd, answerPath(dir))], cwd)
    } catch (error) {
      await deps.store.delete(keyOf(id))
      await deps.files.remove(dir).catch(() => undefined)
      const text = `Codex could not run: ${errorText(error)}`
      return { ok: false, text, error: text }
    }
    return job
  }

  /** Saves the run's result as its kind does, and records how the job ended; a lost run's answer is looked for first. */
  async function finish(deps: RunnerDeps, job: Job, ended: RunResult | 'lost'): Promise<Outcome> {
    let result = ended
    if (result === 'lost') {
      const message = job.threadId ? await deps.files.recover(job.threadId, job.startedAt).catch(() => undefined) : undefined
      result = message === undefined ? 'lost' : { threadId: job.threadId, message }
    }
    const outcome =
      result === 'lost'
        ? ({ ok: false, text: LOST, error: LOST, threadId: job.threadId } as Outcome)
        : await (job.kind === 'image' ? saveImages(deps.output, result, job.request, new Set(job.before)) : saveAnswer(deps.output, result, job.request)).catch(
            error => ({ ok: false, text: errorText(error), error: errorText(error) }) as Outcome,
          )
    job.status = result === 'lost' ? 'lost' : outcome.ok ? 'done' : 'failed'
    job.endedAt = nowOf(deps)
    job.threadId = outcome.threadId ?? job.threadId
    job.paths = outcome.paths
    job.error = outcome.error
    return outcome
  }

  // The end notice goes out once, from the job's one watcher.
  async function notify(deps: RunnerDeps, job: Job, outcome: Outcome) {
    job.notified = true
    await save(deps, job)
    deps.toast(`Codex job #${job.id} ${job.status}`)
    // A submitted prompt is a new turn that reaches the model like the person's words: send only the automated
    // notice, with paths and the thread, never the answer (unverified Codex output).
    await deps.submit(jobMessage(job, outcome)).catch(() => undefined)
  }

  // A run past the background limit: stopped when its process is still that run, then reported as timed out. With no
  // process to stop it ended or died meanwhile, and is read as that.
  async function timeOut(deps: RunnerDeps, job: Job): Promise<Outcome> {
    if (!(await deps.files.stop(job.dir).catch(() => false))) {
      const now = await seen(deps, job)
      return finish(deps, job, 'ended' in now ? now.ended : 'lost')
    }
    const { backgroundMs } = limits()
    const error = `Codex did not finish within ${minutesOf(backgroundMs)} min; the run was stopped.`
    return finish(deps, job, { threadId: job.threadId, error, timedOut: true })
  }

  /**
   * Watches a background job, as its one watcher, to its end or its limit, then records it and sends its notice here.
   * A watch whose wait fails lets go and leaves the run going: the module is likely going away, and the next
   * `resume` picks the job up. A watch another one took over stops without a word.
   */
  async function watch(deps: RunnerDeps, job: Job) {
    const token = freshId(nowOf(deps))
    job.watcher = token
    job.sessionId = await deps.sessionId()
    job.background = true
    job.seenAt = nowOf(deps)
    await save(deps, job)
    const { backgroundMs } = limits()
    const ended = await waitFor(deps, job, job.startedAt + backgroundMs, token).catch((): Released => 'released')
    if (ended === 'released') return
    // The last word is the owner's: a watcher that lost the job meanwhile leaves it to the new one.
    const now = await stored(deps, job.id)
    if (now?.watcher !== token || now.status !== 'running') return
    const outcome = ended === undefined ? await timeOut(deps, job) : await finish(deps, job, ended)
    await notify(deps, job, outcome)
  }

  const adopt = (deps: RunnerDeps, job: Job) => void watch(deps, job).catch(() => undefined)

  /**
   * Runs a request in the foreground; past the foreground wait it goes on as a background job. The background limit
   * bounds the whole run, so it also cuts the foreground wait short. A run that ends in the foreground leaves no job;
   * one whose wait fails goes on as a job, never stopped for it.
   */
  async function runNow(deps: RunnerDeps, request: Request): Promise<Outcome> {
    const job = await start(deps, request, false)
    if (!('dir' in job)) return job
    const { foregroundMs, backgroundMs } = limits()
    const waitMs = Math.min(foregroundMs, backgroundMs)
    let ended: RunResult | 'lost' | Released | undefined
    let failure: string | undefined
    try {
      ended = await waitFor(deps, job, job.startedAt + waitMs)
    } catch (error) {
      failure = errorText(error)
    }
    if (ended !== undefined && ended !== 'released') {
      const outcome = await finish(deps, job, ended)
      await deps.store.delete(keyOf(job.id))
      await deps.files.remove(job.dir).catch(() => undefined)
      return outcome
    }
    adopt(deps, job)
    const moved = movedToBackground(job, minutesOf(waitMs))
    return failure === undefined ? moved : { ...moved, text: `The wait for Codex failed (${failure}). ${moved.text}` }
  }

  /** Starts a request as a background job at once, or answers why it could not start. */
  async function startJob(deps: RunnerDeps, request: Request): Promise<Job | Outcome> {
    const job = await start(deps, request, true)
    if ('dir' in job) adopt(deps, job)
    return job
  }

  async function jobs(deps: RunnerDeps): Promise<Job[]> {
    const keys = (await deps.store.keys()).filter(key => key.startsWith(KEY))
    const values = await Promise.all(keys.map(key => deps.store.get(key)))
    return values.filter(isJob).sort((a, b) => a.startedAt - b.startedAt)
  }

  // Finished jobs past a week, or past the newest KEEP_JOBS jobs, go with their run folders.
  async function prune(deps: RunnerDeps, all: Job[]) {
    const now = nowOf(deps)
    const finished = all.filter(job => job.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const room = Math.max(0, KEEP_JOBS - (all.length - finished.length))
    const gone = finished.filter((job, i) => i >= room || now - (job.endedAt ?? 0) > KEEP_MS)
    for (const job of gone) {
      await deps.store.delete(keyOf(job.id))
      await deps.files.remove(job.dir).catch(() => undefined)
    }
    return all.filter(job => !gone.includes(job))
  }

  /**
   * At session start (a reload, a new session): prunes, then watches again the running jobs of this project that are
   * this session's (its id survives a reload) or that no watcher has seen for a while (their session ended or changed
   * id). A watch finds at once a job that ended, lost its process or ran past the limit, and its notice comes here.
   * Another project's job is left to its own sessions, until it is unwatched and past its limit.
   */
  async function resume(deps: RunnerDeps): Promise<void> {
    const me = await deps.sessionId()
    const project = await deps.project()
    const now = nowOf(deps)
    const { backgroundMs } = limits()
    for (const job of await prune(deps, await jobs(deps))) {
      if (job.status !== 'running') continue
      const unwatched = now - job.seenAt > STALE_MS
      if (job.project === project) {
        if (job.sessionId === me || unwatched) adopt(deps, job)
      } else if (unwatched && now > job.startedAt + backgroundMs) {
        // Another project's job that no session of it came back for: ended here without a notice, so it stops
        // running and stops holding a place among the kept jobs.
        await timeOut(deps, job)
        await save(deps, job)
      }
    }
  }

  /** What the jobs tool answers: this project's background jobs, of any session, newest first. */
  async function report(deps: RunnerDeps): Promise<string> {
    const project = await deps.project()
    return jobsReport((await jobs(deps)).filter(job => job.background && job.project === project), nowOf(deps))
  }

  return { runNow, startJob, resume, report }
}
