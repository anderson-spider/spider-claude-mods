// The host fake the plugin's register tests share: records the commands the plugin registers and answers the `$`
// calls beneath it (env, files, processes, git, the job files and the agy runs) from a scripted state. The tools are
// called as the MCP server calls them: the service on the module's own host, without the status line, toasts or new
// turns the server lacks.
import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'
import { LAUNCH } from '../hooks/detached'
import { STORE_WRITE } from '../hooks/jobs'
import { createService, type Host, type ToolName } from '../hooks/service'
import { settingsOf } from '../hooks/settings'
import { FINGERPRINT } from '../hooks/workspace'

export type Tool = { name: string }

/** The Claude Code process, as `echo $PPID` tells the module and `process.ppid` the server. */
export const PID = 4242

/** Where the job files go under the test's TMPDIR. */
export const JOBS = '/tmp/t/agy/jobs'

type Answer = { result?: unknown; isError?: boolean }

// The world the test made last: a tool call runs on its fake host. A test makes one world, before its calls.
let current: { host: Host } | undefined

/**
 * A tool call as the MCP server answers it: the service on the server's host (server/host.mjs), which the world's
 * fake answers directly, since the MCP server is no hooks module and has no `$`. Takes `$` to read as the plugin's calls.
 */
export async function call(_$: unknown, tool: ToolName, input: Record<string, unknown> = {}, options?: Record<string, unknown>): Promise<Answer> {
  if (!current) throw new Error('call world(on) before a tool call')
  return createService(() => settingsOf(options)).tool(current.host, tool, input)
}

/** One scripted agy run: what it prints on stdout (stream-json) and stderr, its exit code, and what it does as it ends. */
export type AgyRun = { stdout: string; stderr?: string; code?: number; onEnd?: () => void }

type Done = { exitCode: number; stdout?: string; stderr?: string }

/** A listed folder entry: a file or a folder, and when it last changed. */
export type Entry = { name: string; kind: 'file' | 'dir'; mtimeMs: number }

export type HostState = {
  env: Record<string, string | undefined>
  /** The paths that exist. */
  files: Set<string>
  /** What the next detached agy runs print, in turn. */
  agy: AgyRun[]
  /** What `agy <args>` answers for a `$.process.run`, by its arguments joined with spaces. */
  runs: Record<string, Done>
  /** What reading a text file gives, by path. */
  texts: Record<string, string>
  /**
   * What `git <args>` answers, by its arguments joined with spaces, a review worktree's folder written `<wt>`; one not
   * listed fails as outside a repository does.
   */
  git: Record<string, Done>
  /** What other commands answer, by their whole argv joined with spaces. */
  commands: Record<string, Done>
  /** Folder listings by path: the names in it (a folder each), or entries with their kind and modification time. */
  dirs: Record<string, (string | Entry)[]>
  /** What the plugin's `$.store` holds at the start: an earlier version's jobs. */
  store: Record<string, unknown>
  /** `git` cannot run at all, as where it is not installed. */
  gitFails?: boolean
  /** What the working tree's fingerprints are, in turn (hooks/workspace.ts takes one before and one after a run). */
  fingerprints: string[]
}

const result = (done: Done) => ({
  value: { exitCode: done.exitCode, stdout: done.stdout ?? '', stderr: done.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
})

export function world(on: On, init: Partial<HostState> = {}) {
  const state: HostState = {
    env: { TMPDIR: '/tmp/t/', HOME: '/h', PATH: '/usr/bin:/bin' },
    files: new Set(['/h/.local/bin/agy']),
    agy: [],
    runs: { models: { exitCode: 0, stdout: 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n' } },
    texts: {},
    git: {},
    commands: {},
    dirs: {},
    store: {},
    fingerprints: [],
    ...init,
  }
  const tools: Tool[] = []
  const commands: string[] = []
  const launched: { argv: string[]; cwd?: string }[] = []
  const processes: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const written: { path: string; text: string }[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_000 })
  const toasts: string[] = []
  const submitted: string[] = []
  const waiting: (() => void)[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: e.name } }))
  on('command.register', (_$, e) => (commands.push(e.name), { value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  const env = (name: string) => state.env[name]
  on('env.get', (_$, e) => ({ value: env(e.name) }))
  const store = new Map<string, unknown>(Object.entries(state.store))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, structuredClone(e.value)), { value: undefined }))
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'sess-1' }))

  // A job file under its folder, as the store's write leaves it.
  const saveJob = (path: string, text: string) => {
    state.texts[path] = text
    const dir = path.slice(0, path.lastIndexOf('/'))
    const name = path.slice(dir.length + 1)
    const listed = (state.dirs[dir] ??= []).filter(entry => (typeof entry === 'string' ? entry : entry.name) !== name)
    state.dirs[dir] = [...listed, { name, kind: 'file', mtimeMs: 1 }]
  }
  on('fs.exists', (_$, e) => ({ value: state.files.has(e.path) }))
  const list = (path: string) => {
    const names = state.dirs[path]
    const entries = names?.map(entry => (typeof entry === 'string' ? { name: entry, kind: 'dir' as const, mtimeMs: 1 } : entry))
    return entries ? { value: entries.map(entry => ({ ...entry, size: 1, isLink: false })) } : { deny: `ENOENT: ${path}` }
  }
  on('fs.list', (_$, e) => list(e.path ?? ''))
  const read = (path: string) => (path in state.texts ? { value: state.texts[path]! } : { deny: `ENOENT: ${path}` })
  on('fs.read', (_$, e) => (e.as === 'bytes' ? { value: { base64: 'SlBH' } } : read(e.path)))
  const write = (path: string, text: string) => void written.push({ path, text })
  on('fs.write', (_$, e) => (write(e.path, e.text), { value: undefined }))
  type Run = { argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string } }
  const run = (e: Run): ReturnType<typeof result> | { deny: string } => {
    const argv = [...e.argv]
    processes.push({ argv, cwd: e.init?.cwd, env: e.init?.env as Record<string, string> | undefined })
    // A detached launch (hooks/detached.ts): the next scripted agy run plays out at once into its run folder.
    if (argv[0] === 'sh' && argv[2] === LAUNCH) {
      const [dir = '', cwd = ''] = argv.slice(4, 6)
      launched.push({ argv: argv.slice(6), cwd: cwd || undefined })
      const run = state.agy.shift() ?? { stdout: '', code: 1 }
      state.files.add(dir)
      state.texts[`${dir}/events.jsonl`] = run.stdout
      state.texts[`${dir}/stderr.txt`] = run.stderr ?? ''
      run.onEnd?.()
      state.texts[`${dir}/exit`] = String(run.code ?? 0)
      return result({ exitCode: 0 })
    }
    if (argv[0] === 'sh' && argv[2] === STORE_WRITE) {
      saveJob(argv[5] ?? '', e.init?.stdin ?? '')
      return result({ exitCode: 0 })
    }
    if (argv[0] === 'rm' && argv[1] === '-f' && argv[2]?.startsWith(`${JOBS}/`)) {
      const path = argv[2]
      delete state.texts[path]
      state.dirs[JOBS] = (state.dirs[JOBS] ?? []).filter(entry => typeof entry === 'string' || `${JOBS}/${entry.name}` !== path)
      return result({ exitCode: 0 })
    }
    if (argv[0] === 'sh' && argv[2] === 'echo $PPID') return result({ exitCode: 0, stdout: `${PID}\n` })
    // The ends of a run's files (hooks/detached.ts reads them so): the whole text, which is small here.
    if (argv[0] === 'head' || argv[0] === 'tail') return result({ exitCode: 0, stdout: state.texts[argv.at(-1) ?? ''] ?? '' })
    if (argv[0] === 'sh' && argv[2] === FINGERPRINT) {
      const tree = state.fingerprints.shift()
      return result(tree === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: `${tree}\n` })
    }
    if (argv[0] === 'git') {
      if (state.gitFails) return { deny: 'ENOENT: git' }
      // A review worktree's folder ends in its run's id, which the test does not know: it is keyed as <wt>.
      return result(state.git[argv.slice(1).join(' ').replace(/\/tmp\/t\/agy\/worktrees\/\S+/, '<wt>')] ?? { exitCode: 128 })
    }
    const other = state.commands[argv.join(' ')]
    if (other) return result(other)
    if (argv[0]?.endsWith('/agy')) return result(state.runs[argv.slice(1).join(' ')] ?? { exitCode: 1, stderr: 'not scripted' })
    return result({ exitCode: 0 })
  }
  on('process.run', (_$, e) => run(e as Run))

  // The MCP server's host on this fake: processes, files and the session, without the status line, toasts or new turns.
  const value = <T>(answer: { value: T; deny?: undefined } | { deny: string; value?: undefined }): T => {
    if (answer.deny !== undefined) throw new Error(answer.deny)
    return answer.value as T
  }
  const host: Host = {
    run: async (argv, init) => value(run({ argv, init })),
    env: async name => env(name),
    exists: async path => state.files.has(path),
    read: async path => (path in state.texts ? state.texts[path] : undefined),
    readBytes: async () => ({ base64: 'SlBH' }),
    write: async (path, text) => write(path, text),
    list: async path => value(list(path)),
    sessionId: async () => 'sess-1',
    project: () => '/proj',
    pid: () => PID,
    // A wait moves no time: the jobs' clock is Date.now, and the watcher's beats come from the module's clock.
    sleep: async () => undefined,
  }
  current = { host }
  on('ui.status', (_$, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    for (const wake of waiting.splice(0)) wake()
    return { text: e.text }
  })

  // Resolves once a background job has sent its notice.
  const submission = () => new Promise<void>(resolve => (submitted.length ? resolve() : waiting.push(resolve)))

  /** Moves the clock on in small steps, so the module's watch on handed-off jobs runs, until `done` holds. */
  const until = async (done: () => boolean) => {
    for (let step = 0; step < 50 && !done(); step++) await clock.advance(500)
  }

  return { state, tools, commands, launched, processes, written, statuses, toasts, submitted, submission, store, clock, until }
}

/** Starts the session; the module registers its commands and no tool (the MCP server serves them). */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<void> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  // The start's own work (the process id, the jobs resumed) goes on without holding it up: let it finish
  for (let i = 0; i < 200; i++) await Promise.resolve()
  expect(tools).toEqual([])
}
