import { argsOf } from './args'
import { conversationOf, modelOf, readRun } from './events'
import type { Job, JobStore, OutputDeps, Outcome, Request, RunFiles, RunResult, Workspaces } from './model'
import { imagesBefore, saveAnswer, saveImages } from './output'
import { errorText, failure, jobMessage, jobsReport, movedToBackground } from './presentation'
import { NO_REPO_NOTE } from './workspace'

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
  workspaces: Workspaces
  sessionId(): Promise<string>
  /** The session's folder: an ask runs there, and jobs are listed and taken over within one project. */
  project(): Promise<string>
  /** Where each run gets its folder: `$TMPDIR/agy/runs`. */
  runsDir: string
  sleep(ms: number): Promise<unknown>
  output: OutputDeps
  /** The `agy` executable, or why there is none. */
  agy(): Promise<string | { error: string }>
  toast(text: string): void
  submit(text: string): Promise<unknown>
  now?: () => number
  newId?: () => string
}

export type Limits = { foregroundMs: number; backgroundMs: number }

const minutesOf = (ms: number) => Math.round(ms / 60_000)

const LOST = 'agy stopped before an answer the plugin could read (lost); it is never re-run, so continue the conversation to go on.'

// An id no other session's job shares: the time, then a random suffix.
const freshId = (now: number) => `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`

// The exit status the run's shell wrote: past 128, the signal that ended it (143 is SIGTERM, 137 SIGKILL).
const SIGNALS: Record<number, string> = { 1: 'SIGHUP', 2: 'SIGINT', 9: 'SIGKILL', 15: 'SIGTERM' }
const exitOf = (status: number) => (status > 128 ? { code: null, signal: SIGNALS[status - 128] ?? `signal ${status - 128}` } : { code: status, signal: null })

const isJob = (value: unknown): value is Job =>
  typeof value === 'object' && value !== null && typeof (value as Job).id === 'string' && typeof (value as Job).dir === 'string'

/** What a job keeps of its request: the files went to agy already, and the prompt is cut short (an image's file name and record take it). */
const kept = (request: Request): Request => ({ ...request, prompt: request.prompt.slice(0, PROMPT_KEPT), files: [] })

const busyText = (conversation: string, what: string) =>
  `Conversation ${conversation} is still running as ${what}; ask on it again once that ends (the jobs tool shows it).`

const withNote = (request: Request, line: string | undefined): Request =>
  line ? { ...request, note: request.note ? `${request.note}\n\n${line}` : line } : request

/** What a run is doing now, read from its folder. */
type Seen = { ended: RunResult } | { running: string | undefined } | { gone: true }

/** Why a watch let go of its job: another watcher owns it now, or its wait failed (a reload took the host away). */
type Released = 'released'

/**
 * Every run, foreground or background, in `$.store` and a detached process: the jobs outlive a plugin reload (the
 * session's watch on them starts again in `resume`) and the session (the next one to start takes them over).
 */
export function createRunner(limits: () => Limits) {
  const starting = new Set<string>()
  const nowOf = (deps: RunnerDeps) => (deps.now ?? Date.now)()
  const save = (deps: RunnerDeps, job: Job) => deps.store.set(keyOf(job.id), job)
  const stored = async (deps: RunnerDeps, id: string) => {
    const value = await deps.store.get(keyOf(id))
    return isJob(value) ? value : undefined
  }

  async function seen(deps: RunnerDeps, job: Job): Promise<Seen> {
    const state = await deps.files.read(job.dir)
    if (!state) return { gone: true }
    const conversationId = conversationOf(state.head)
    if (state.exit === undefined) return { running: conversationId }
    const result = readRun(state.tail ?? '', state.stderr ?? '', exitOf(state.exit))
    const model = modelOf(state.head)
    return {
      ended: { ...result, conversationId: result.conversationId ?? conversationId, ...(model ? { model } : {}), ...(state.endedAt ? { endedAt: state.endedAt } : {}) },
    }
  }

  /**
   * Waits for the run until `deadline`: its result, undefined when the time runs out first, or `released` when another
   * watcher took the job over. A run whose process or folder is gone without an exit status ends as lost; one that
   * ended between a read and the process check is read once more first. The conversation is saved as soon as it
   * starts, so a follow-up on it waits, and a heartbeat tells other sessions the job is watched. A failing `sleep`
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
      const conversation = now.running && now.running !== job.conversationId
      if (conversation || reads % HEARTBEAT_EVERY === 0) {
        if (token !== undefined && (await stored(deps, job.id))?.watcher !== token) return 'released'
        job.conversationId = now.running ?? job.conversationId
        job.seenAt = nowOf(deps)
        await save(deps, job)
      }
      const left = deadline - nowOf(deps)
      if (left <= 0) return undefined
      await deps.sleep(Math.min(left, POLL_MS))
    }
  }

  async function jobs(deps: RunnerDeps): Promise<Job[]> {
    const keys = (await deps.store.keys()).filter(key => key.startsWith(KEY))
    const values = await Promise.all(keys.map(key => deps.store.get(key)))
    return values.filter(isJob).sort((a, b) => a.startedAt - b.startedAt)
  }

  const removeWorktree = (deps: RunnerDeps, job: Job) =>
    job.workspace.worktree ? deps.workspaces.remove(job.project, job.workspace.worktree).catch(() => undefined) : Promise.resolve()

  // An image run's work folder goes when the run ends, with whatever agy left in it.
  const discardWorkFolder = (deps: RunnerDeps, job: Job) =>
    job.workspace.workFolder ? deps.workspaces.discard(job.workspace.workFolder).catch(() => undefined) : Promise.resolve()

  /**
   * Starts a run: its job is in the store before its workspace is made, so a session start meanwhile never sweeps a
   * review worktree that is still being built, and any failure on the way takes the job, its folder and its worktree
   * back out. The deadlines count from just before the launch, after the git work.
   */
  async function start(deps: RunnerDeps, request: Request, background: boolean): Promise<Job | Outcome> {
    const agy = await deps.agy()
    if (typeof agy !== 'string') return failure(agy.error)
    const conversation = request.conversationId
    // Two turns at once on one conversation hang agy: a follow-up waits for the run before it. `starting` holds the
    // conversations this module is starting, reserved before any wait, which the store shows only once their job is saved.
    if (conversation) {
      if (starting.has(conversation)) return failure(busyText(conversation, 'a run that is starting'))
      starting.add(conversation)
    }
    try {
      if (conversation) {
        const busy = (await jobs(deps)).find(job => job.status === 'running' && job.conversationId === conversation)
        if (busy) return failure(busyText(conversation, `job #${busy.id}`))
      }
      const project = await deps.project()
      const id = deps.newId?.() ?? freshId(nowOf(deps))
      const dir = `${deps.runsDir}/${id}`
      const job: Job = {
        id,
        kind: request.kind,
        prompt: request.prompt.slice(0, PROMPT_KEPT),
        status: 'running',
        startedAt: nowOf(deps),
        ...(conversation ? { conversationId: conversation } : {}),
        sessionId: await deps.sessionId(),
        project,
        seenAt: nowOf(deps),
        dir,
        background,
        request: kept(request),
        workspace: request.kind === 'review' ? { cwd: deps.workspaces.pathOf(id), worktree: deps.workspaces.pathOf(id) } : { cwd: project },
      }
      await save(deps, job)
      try {
        let ran = request
        if (request.kind === 'review') {
          // resolveReview (review.ts) gives every review its target before it gets here.
          const made = await deps.workspaces.review(project, id, request.review!)
          if ('error' in made) {
            await deps.store.delete(keyOf(id))
            return failure(made.error)
          }
          job.workspace = made
        } else if (request.kind === 'image') {
          // An image runs in an empty folder of the plugin's, never the project; a follow-up's artifacts folder holds
          // the earlier images already, so only the new ones are this run's.
          job.before = await imagesBefore(deps.output, conversation)
          job.workspace = await deps.workspaces.image(id)
        } else {
          job.workspace = await deps.workspaces.ask(project)
          if (job.workspace.before === undefined) ran = withNote(request, NO_REPO_NOTE)
        }
        job.request = kept(ran)
        job.startedAt = nowOf(deps)
        job.seenAt = job.startedAt
        await save(deps, job)
        await deps.files.launch(dir, [agy, ...argsOf(ran, job.workspace, limits().backgroundMs)], job.workspace.cwd)
        return job
      } catch (error) {
        await deps.store.delete(keyOf(id)).catch(() => undefined)
        await deps.files.remove(dir).catch(() => undefined)
        await removeWorktree(deps, job)
        await discardWorkFolder(deps, job)
        return failure(`agy could not run: ${errorText(error)}`)
      }
    } finally {
      if (conversation) starting.delete(conversation)
    }
  }

  /**
   * Checks the workspace for edits, saves the run's answer (an image run's images), removes a review's worktree or an
   * image's work folder and records how it ended.
   */
  async function finish(deps: RunnerDeps, job: Job, ended: RunResult | 'lost'): Promise<Outcome> {
    const warning = await deps.workspaces.changed(job.workspace).catch(() => undefined)
    await removeWorktree(deps, job)
    await discardWorkFolder(deps, job)
    const request = withNote(job.request, warning)
    const save = (result: RunResult) =>
      job.kind === 'image'
        ? saveImages(deps.output, result, request, job.before ?? [], request.model ?? result.model)
        : saveAnswer(deps.output, result, request, request.model ?? result.model)
    const outcome =
      ended === 'lost' ? failure(LOST, { conversationId: job.conversationId, note: request.note }) : await save(ended).catch(error => failure(errorText(error)))
    job.status = ended === 'lost' ? 'lost' : outcome.ok ? 'done' : 'failed'
    job.endedAt = (ended !== 'lost' && ended.endedAt) || nowOf(deps)
    job.conversationId = outcome.conversationId ?? job.conversationId
    job.paths = outcome.paths
    job.error = outcome.error
    return outcome
  }

  // The end notice goes out once, from the job's one watcher.
  async function notify(deps: RunnerDeps, job: Job, outcome: Outcome) {
    job.notified = true
    await save(deps, job)
    deps.toast(`agy job #${job.id} ${job.status}`)
    // A submitted prompt is a new turn that reaches the model like the person's words: send only the automated
    // notice, with paths and the conversation, never the answer (unverified agy output).
    await deps.submit(jobMessage(job, outcome)).catch(() => undefined)
  }

  // A run past the background limit: stopped when its process is still that run, then reported as timed out.
  async function timeOut(deps: RunnerDeps, job: Job): Promise<Outcome> {
    await deps.files.stop(job.dir).catch(() => false)
    const error = `agy failed (timed out): it did not finish within ${minutesOf(limits().backgroundMs)} min, and the run was stopped.`
    return finish(deps, job, { conversationId: job.conversationId, error, reason: 'timed out', timedOut: true })
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
    const ended = await waitFor(deps, job, job.startedAt + limits().backgroundMs, token).catch((): Released => 'released')
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
    let failed: string | undefined
    try {
      ended = await waitFor(deps, job, job.startedAt + waitMs)
    } catch (error) {
      failed = errorText(error)
    }
    if (ended !== undefined && ended !== 'released') {
      const outcome = await finish(deps, job, ended)
      await deps.store.delete(keyOf(job.id))
      await deps.files.remove(job.dir).catch(() => undefined)
      return outcome
    }
    adopt(deps, job)
    const moved = movedToBackground(job, nowOf(deps) - job.startedAt)
    return failed === undefined ? moved : { ...moved, text: `The wait for agy failed (${failed}). ${moved.text}` }
  }

  /** Starts a request as a background job at once, or answers why it could not start. */
  async function startJob(deps: RunnerDeps, request: Request): Promise<Job | Outcome> {
    const job = await start(deps, request, true)
    if ('dir' in job) adopt(deps, job)
    return job
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

  // Review worktrees whose job is not running any more (it ended in a session that went away first, or is gone).
  async function sweep(deps: RunnerDeps, all: Job[]) {
    const running = new Set(all.filter(job => job.status === 'running').map(job => job.id))
    const project = await deps.project()
    for (const id of await deps.workspaces.left()) {
      if (running.has(id)) continue
      const owner = all.find(job => job.id === id)
      await deps.workspaces.remove(owner?.project ?? project, deps.workspaces.pathOf(id)).catch(() => undefined)
    }
  }

  /**
   * At session start (a reload, a new session): prunes and sweeps, then watches again the running jobs of this project
   * that are this session's (its id survives a reload) or that no watcher has seen for a while (their session ended or
   * changed id). A watch finds at once a job that ended, lost its process or ran past the limit, and its notice comes
   * here.
   */
  async function resume(deps: RunnerDeps): Promise<void> {
    const me = await deps.sessionId()
    const project = await deps.project()
    const now = nowOf(deps)
    const all = await prune(deps, await jobs(deps))
    await sweep(deps, all)
    for (const job of all) {
      if (job.status !== 'running' || job.project !== project) continue
      if (job.sessionId === me || now - job.seenAt > STALE_MS) adopt(deps, job)
    }
  }

  /** What the jobs tool answers: this project's background jobs, of any session, newest first. */
  async function report(deps: RunnerDeps): Promise<string> {
    const project = await deps.project()
    return jobsReport((await jobs(deps)).filter(job => job.background && job.project === project), nowOf(deps))
  }

  return { runNow, startJob, resume, report }
}
