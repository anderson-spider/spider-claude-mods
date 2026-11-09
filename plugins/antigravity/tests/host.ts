// The host fake the plugin's register tests share: records the tools and commands the plugin registers and answers
// the `$` calls beneath it (env, files, processes, git and the agy runs) from a scripted state.
import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import { LAUNCH } from '../hooks/detached'
import { FINGERPRINT } from '../hooks/workspace'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__antigravity__${name}`

/** One scripted agy run: what it prints on stdout (stream-json) and stderr, its exit code, and what it does as it ends. */
export type AgyRun = { stdout: string; stderr?: string; code?: number; onEnd?: () => void }

type Done = { exitCode: number; stdout?: string; stderr?: string }

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
  /** Folder listings by path: the names in it. */
  dirs: Record<string, string[]>
  /** What the plugin's `$.store` holds at the start. */
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
    const names = state.dirs[e.path ?? '']
    return names ? { value: names.map(name => ({ name, kind: 'dir' as const, mtimeMs: 1, size: 1, isLink: false })) } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_$, e) => (e.path in state.texts ? { value: state.texts[e.path]! } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', (_$, e) => (written.push({ path: e.path, text: e.text }), { value: undefined }))
  on('process.run', (_$, e) => {
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

  return { state, tools, commands, launched, processes, written, statuses, toasts, submitted, submission }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map(tool => tool.name)
}
