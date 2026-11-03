// The host fake the plugin's register tests share: records the tools and commands the plugin registers and answers
// the `$` calls beneath it (env, files, processes and the Codex child) from a scripted state.
import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import { LAUNCH } from '../hooks/detached'
import type { FsEntry } from '../hooks/model'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__codex__${name}`

export type HostState = {
  env: Record<string, string | undefined>
  /** The paths that exist. */
  files: Set<string>
  /** Folder listings by path. */
  dirs: Record<string, FsEntry[]>
  /** What the next `codex` children print, in turn; `onEnd` runs as one ends (Codex saving an image). */
  codex: { stdout: string; code?: number; onEnd?: () => void }[]
  /** What `codex <args>` prints for a `$.process.run`, by its arguments. */
  runs: Record<string, { exitCode: number; stdout?: string; stderr?: string }>
  /** What reading a text file gives, by path. */
  texts: Record<string, string>
  /** What `git <args>` answers, by its arguments; one not listed fails as outside a repository does. */
  git: Record<string, { exitCode: number; stdout?: string }>
  /** What other commands print, by their whole argv joined with spaces. */
  commands: Record<string, { exitCode: number; stdout?: string }>
  /** What the plugin's `$.store` holds at the start. */
  store: Record<string, unknown>
  /** `git` cannot run at all, as where it is not installed. */
  gitFails?: boolean
  /** What `uname -s` prints; `undefined` makes it fail, as where there is no `uname`. */
  uname?: string
}

export function world(on: On, init: Partial<HostState> = {}) {
  const state: HostState = {
    env: { TMPDIR: '/tmp/t/', HOME: '/h', PATH: '/usr/bin:/bin' },
    files: new Set(['/h/.local/bin/codex']),
    dirs: {},
    codex: [],
    runs: {},
    texts: {},
    git: {},
    commands: {},
    store: {},
    uname: 'Linux\n',
    ...init,
  }
  const tools: Tool[] = []
  const commands: string[] = []
  const spawned: { argv: string[]; cwd?: string }[] = []
  const processes: string[][] = []
  const written: { path: string; text: string }[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const submitted: string[] = []
  const waiting: (() => void)[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('command.register', (_$, e) => (commands.push(e.name), { value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: state.env[e.name] }))
  const store = new Map<string, unknown>(Object.entries(state.store))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, structuredClone(e.value)), { value: undefined }))
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.exists', (_$, e) => ({ value: state.files.has(e.path) }))
  on('fs.list', (_$, e) => {
    const entries = state.dirs[e.path ?? '']
    return entries ? { value: entries.map(entry => ({ ...entry, size: 1, isLink: false })) } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_$, e) => (e.as === 'bytes' ? { value: { base64: 'SlBH' } } : { value: state.texts[e.path] ?? '' }))
  on('fs.write', (_$, e) => (written.push({ path: e.path, text: e.text }), { value: undefined }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    processes.push(argv)
    // A detached launch (hooks/detached.ts): the next scripted Codex run plays out at once into its run folder.
    if (argv[0] === 'sh' && argv[2] === LAUNCH) {
      const [dir = '', cwd = ''] = argv.slice(4, 6)
      spawned.push({ argv: argv.slice(6), cwd: cwd || undefined })
      const child = state.codex.shift() ?? { stdout: '', code: 1 }
      state.files.add(dir)
      state.texts[`${dir}/events.jsonl`] = child.stdout
      child.onEnd?.()
      state.texts[`${dir}/exit`] = String(child.code ?? 0)
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    // The ends of a run's files (hooks/detached.ts reads them so): the whole text, which is small here.
    if ((argv[0] === 'head' || argv[0] === 'tail') && argv[1] === '-c') {
      return { value: { exitCode: 0, stdout: state.texts[argv[3] ?? ''] ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'git') {
      if (state.gitFails) return { deny: 'ENOENT: git' }
      const known = state.git[argv.slice(1).join(' ')] ?? { exitCode: 128, stdout: '' }
      return { value: { exitCode: known.exitCode, stdout: known.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'uname') {
      if (state.uname === undefined) return { deny: 'ENOENT: uname' }
      return { value: { exitCode: 0, stdout: state.uname, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const other = state.commands[argv.join(' ')]
    if (other) return { value: { exitCode: other.exitCode, stdout: other.stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const known = state.runs[argv.slice(1).join(' ')]
    const done = argv[0]?.endsWith('/codex') && known ? known : { exitCode: argv[0] === 'sips' ? 1 : 0 }
    return { value: { exitCode: done.exitCode, stdout: 'stdout' in done ? (done.stdout ?? '') : '', stderr: 'stderr' in done ? (done.stderr ?? '') : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    for (const wake of waiting.splice(0)) wake()
    return { text: e.text }
  })

  // Resolves once a background job has sent its notice.
  const submission = () => new Promise<void>(resolve => (submitted.length ? resolve() : waiting.push(resolve)))

  return { state, tools, commands, spawned, processes, written, statuses, toasts, submitted, submission }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map(tool => tool.name)
}
