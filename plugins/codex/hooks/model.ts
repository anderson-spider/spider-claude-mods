/** What a request asks for: an answer (`ask`) or an image (`image`). */
export type Kind = 'ask' | 'image'

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

export type Job = {
  id: number
  kind: Kind
  prompt: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  threadId?: string
  paths?: string[]
  /** Why a failed job failed, as its notice said. */
  error?: string
}

export type Check = { name: string; ok: boolean; detail: string }
