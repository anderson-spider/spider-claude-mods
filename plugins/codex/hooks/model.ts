/** What a request asks for: an answer (`ask`), an image (`image`) or a review of the repository's changes (`review`). */
export type Kind = 'ask' | 'image' | 'review'

/** The changes a review covers: the branch against a base, one commit, the uncommitted changes, or free instructions. */
export type ReviewTarget = { base: string } | { commit: string } | { uncommitted: true } | { instructions: string }

/**
 * What to run. `threadId` continues a Codex session (`codex exec resume`), else a new one starts; `model` and
 * `effort` override the user's Codex config for this run; `images` go to Codex with `--image`, `files` are named in
 * the prompt for Codex to read.
 */
export type Request = {
  kind: Kind
  prompt: string
  threadId?: string
  model?: string
  effort?: string
  images: string[]
  files: string[]
  out?: string
  maxChars?: number
  /** A review's target; absent on an ask or image. */
  review?: ReviewTarget
  /** A line the plugin puts before Codex's answer in the saved file, such as what a review left out. */
  note?: string
}

/** What a Codex run came to, read from its `--json` events. */
export type RunResult = {
  threadId?: string
  /** The last agent message: Codex's answer. */
  message?: string
  /** The turn's failure or the last error event, or why the process ended without a turn. */
  error?: string
  /** The run outlived its time limit and was stopped. */
  timedOut?: boolean
}

/** One piece of a spawned child's output, and how it ended: `$.process.spawn`'s shapes. */
export type Chunk = { stream: 'stdout' | 'stderr'; text: string }
export type Exit = { code: number | null; signal: string | null }
export type Spawned = AsyncGenerator<Chunk, Exit>

/** Starts a child by its argument vector in `cwd`, the session's folder when absent. */
export type Spawn = (argv: string[], cwd: string | undefined) => Spawned

export type ProcessRunner = (
  argv: string[],
  init?: { timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>

// An image block of a tool's result, in the Anthropic API shape: the host
// passes it on as is, and drops the MCP shape ({ data, mimeType }) silently.
export type Preview = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** What a request came to; `error` holds only plugin error text, never Codex output. */
export type Outcome = {
  ok: boolean
  text: string
  error?: string
  threadId?: string
  paths?: string[]
  timedOut?: boolean
  previews?: Preview[]
  markdown?: string
}

export type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

export type OutputDeps = {
  run: ProcessRunner
  write(path: string, text: string): Promise<void>
  readBytes(path: string): Promise<{ base64: string }>
  list(path: string): Promise<FsEntry[]>
  /** The folder results go to: `$TMPDIR/codex`. */
  outDir: string
  /** Codex's own folder: `$CODEX_HOME`, else `~/.codex`. */
  codexHome: string
}

/**
 * One run as `$.store` keeps it, under `job:<id>`: a foreground run until its wait runs out, then a background job.
 * It outlives a plugin reload and the session, since its Codex process runs detached (`RunFiles`).
 */
export type Job = {
  /** Unique across sessions: time-based with a random suffix. */
  id: string
  kind: Kind
  prompt: string
  status: 'running' | 'done' | 'failed' | 'lost'
  startedAt: number
  endedAt?: number
  threadId?: string
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
  /** What it runs, without its images and files, to save its result the same way whichever session sees it end. */
  request: Request
  /** For an image follow-up: the images its thread already had, left out of its result. */
  before: string[]
}

/**
 * What a detached run's folder says now: the start of its events (the thread), and once it ended its exit status and
 * time, the end of its events and stderr (why it failed), and its last message as `-o` wrote it.
 */
export type RunState = { head: string; exit?: number; endedAt?: number; tail?: string; stderr?: string; answer?: string }

/** A Codex process that runs detached, its output in a folder of files, so it survives a plugin reload. */
export type RunFiles = {
  /** Starts `argv` in `cwd` (the session's folder when absent), writing into `dir`; rejects when it cannot start. */
  launch(dir: string, argv: string[], cwd: string | undefined): Promise<void>
  /** The run's state, or undefined when its folder is gone (a reboot cleared it). */
  read(dir: string): Promise<RunState | undefined>
  /** Whether the run's process is still that Codex run; true while its pid is not written yet. */
  alive(dir: string): Promise<boolean>
  /** Stops the run when its process is still that Codex run; false when it was not (gone, or a reused pid). */
  stop(dir: string): Promise<boolean>
  /** Deletes the run's folder. */
  remove(dir: string): Promise<void>
  /** Codex's last answer in a thread since `sinceMs`, read back from its own session files, or undefined. */
  recover(threadId: string, sinceMs: number): Promise<string | undefined>
}

/** The part of `$.store` the jobs use. */
export type JobStore = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type Check = { name: string; ok: boolean; detail: string }
