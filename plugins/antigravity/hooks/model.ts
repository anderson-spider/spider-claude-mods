/** What a request asks for: an answer (`ask`), an image (`image`) or a review of the repository's changes (`review`). */
export type Kind = 'ask' | 'image' | 'review'

/** The changes a review covers: the branch against a base, or one commit. */
export type ReviewTarget = { base: string } | { commit: string }

/**
 * What to run. `conversationId` continues an agy conversation (`--conversation`), else a new one starts; `model` and
 * `effort` override agy's defaults for this run; `files` are named in the prompt for agy to read.
 */
export type Request = {
  kind: Kind
  prompt: string
  conversationId?: string
  model?: string
  effort?: string
  files: string[]
  /** An image request's picture to edit from. */
  reference?: string
  out?: string
  maxChars?: number
  /** A review's target; absent on an ask. */
  review?: ReviewTarget
  /** A review's extra concern, appended to its prompt. */
  focus?: string
  /** Lines the plugin puts before agy's answer in the saved file, such as what a review left out. */
  note?: string
}

/** Why a run failed, in the closed set the person reads. */
export type Reason = 'quota exhausted' | 'timed out' | 'interrupted' | 'local error' | 'agy error' | 'lost'

/** What an agy run came to, read from its stream-json events, its stderr and its exit status. */
export type RunResult = {
  conversationId?: string
  /** The `result` event's response: agy's answer. */
  message?: string
  /** Why it failed, redacted; absent on success. */
  error?: string
  reason?: Reason
  /** When the run ended, from its exit file: a job found ended later keeps the time it really ended. */
  endedAt?: number
  /** The model agy says it used, from its `init` event. */
  model?: string
  /** The run outlived its time limit and was stopped. */
  timedOut?: boolean
}

export type ProcessRunner = (
  argv: string[],
  init?: { timeoutMs?: number; cwd?: string; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

/** A small copy of a saved image, handed back with the tool result so the model sees it. */
export type Preview = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** A folder entry as `$.fs.list` gives it. */
export type Entry = { name: string; kind: 'file' | 'dir' | 'symlink' | 'other'; mtimeMs: number }

/** What a request came to; `error` holds only plugin error text, never agy's answer. */
export type Outcome = {
  ok: boolean
  text: string
  error?: string
  conversationId?: string
  paths?: string[]
  timedOut?: boolean
  markdown?: string
  previews?: Preview[]
}

export type OutputDeps = {
  write(path: string, text: string): Promise<void>
  /** The folder results go to: `$TMPDIR/agy`. */
  outDir: string
  /** Where agy keeps each conversation's artifacts folder, its images among them: `~/.gemini/antigravity-cli/brain`. */
  brainDir: string
  /** A folder's entries; rejects when it is missing. */
  list(path: string): Promise<Entry[]>
  run: ProcessRunner
  readBytes(path: string): Promise<{ base64: string }>
}

/** Where a run works and what it was handed: an ask's folder, or a review's worktree with its diff file. */
export type Workspace = {
  /** The folder agy runs in. */
  cwd: string
  /** The working tree's fingerprint before the run, compared after it; undefined outside a git repository. */
  before?: string
  /** A review's worktree, removed when the run ends. */
  worktree?: string
  /** A review's diff file and the files it changes, named in its prompt. */
  diff?: { path: string; files: string[] }
  /** An image run's work folder, deleted when the run ends. */
  scratch?: string
}

/**
 * One run as `$.store` keeps it, under `job:<id>`: a foreground run until its wait runs out, then a background job.
 * It outlives a plugin reload and the session, since its agy process runs detached (`RunFiles`).
 */
export type Job = {
  /** Unique across sessions: time-based with a random suffix. */
  id: string
  kind: Kind
  prompt: string
  status: 'running' | 'done' | 'failed' | 'lost'
  startedAt: number
  endedAt?: number
  conversationId?: string
  paths?: string[]
  /** Why a failed or lost job ended so, as its notice said. */
  error?: string
  /** The session watching it, which gets its end notice: the one that started it, or one that took it over. */
  sessionId: string
  /** The folder of the session that started it: jobs are listed and taken over within one project. */
  project: string
  /** When its watcher last saw it running; a job not seen for a while has no watcher and is taken over. */
  seenAt: number
  /** The watcher that owns it now: a watcher whose token is no longer here stops, so one job has one watcher. */
  watcher?: string
  /** Its run folder: events, stderr, pid and exit status. */
  dir: string
  /** False while a foreground call still waits on it: such a run is not listed as a job. */
  background: boolean
  /** Its end notice went out. */
  notified?: boolean
  /** What it runs, without its files, to save its result the same way whichever session sees it end. */
  request: Request
  /** Where it runs: checked for edits and, for a review, removed when it ends. */
  workspace: Workspace
  /** An image job's names already in its conversation's artifacts folder, so only the run's own images are saved. */
  before?: string[]
}

/** What a detached run's folder says now: the start of its events, and once it ended its exit status, time and ends. */
export type RunState = { head: string; exit?: number; endedAt?: number; tail?: string; stderr?: string }

/** An agy process that runs detached, its output in a folder of files, so it survives a plugin reload. */
export type RunFiles = {
  /** Starts `argv` in `cwd`, writing into `dir`; rejects when it cannot start. */
  launch(dir: string, argv: string[], cwd: string): Promise<void>
  /** The run's state, or undefined when its folder is gone (a reboot cleared it). */
  read(dir: string): Promise<RunState | undefined>
  /** Whether the run's process is still that agy run; true while its pid is not written yet. */
  alive(dir: string): Promise<boolean>
  /** Stops the run when its process is still that agy run; false when it was not (gone, or a reused pid). */
  stop(dir: string): Promise<boolean>
  /** Deletes the run's folder. */
  remove(dir: string): Promise<void>
}

/** The git side of a run: the ask's edit check and the review's worktree. */
export type Workspaces = {
  /** An ask's workspace: the session's folder and its fingerprint. */
  ask(project: string): Promise<Workspace>
  /** A review's worktree for `id`, with its diff file written, or why it could not be made. */
  review(project: string, id: string, target: ReviewTarget): Promise<Workspace | { error: string }>
  /** An image run's work folder for `id`, made empty, away from any repository. */
  image(id: string): Promise<Workspace>
  /** Deletes an image run's work folder. */
  discard(path: string): Promise<void>
  /** Whether the workspace changed since `before`: a warning line, or undefined when it did not (or cannot tell). */
  changed(workspace: Workspace): Promise<string | undefined>
  /** Removes a review's worktree. */
  remove(project: string, worktree: string): Promise<void>
  /** The ids of the worktrees left on disk. */
  left(): Promise<string[]>
  /** Where the worktree of run `id` goes. */
  pathOf(id: string): string
}

/** The part of `$.store` the jobs use. */
export type JobStore = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type Check = { name: string; ok: boolean; detail: string }
