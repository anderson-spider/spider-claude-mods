// The host fake the plugin's tests share: answers the events around the plugin, records what it
// registers, runs, shows and sends, and keeps a small file system for the secrets folder and its queues.
import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'

export type Tool = { name: string }

export const HOME = '/home/me'
export const DIR = `${HOME}/.claude/secrets`
/** The Claude Code process, as `echo $PPID` tells the module. */
export const PID = 4242
export const QUEUE = `${DIR}/.requests/${PID}`

const done = (exitCode: number) => ({ exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

export type Init = {
  /** The folder's files: path below the folder to text and modification time (default 0). */
  files?: Record<string, { text: string; mtimeMs?: number }>
  /** Folders below the secrets folder that hold no file, with their modification time. */
  dirs?: Record<string, number>
  /** What ui.open answers: whether a surface draws the pane now. */
  isPlaced?: boolean
  /** What ui.panes says of the pane, which a surface may seat after ui.open answered: ui.open's answer by default. */
  seated?: boolean
  /** The exit code of the process that writes a secret file. */
  writeExit?: number
  now?: number
}

export function world(on: On, init: Init = {}) {
  const files = new Map(Object.entries(init.files ?? {}).map(([name, file]) => [`${DIR}/${name}`, { mtimeMs: 0, ...file }]))
  const dirs = new Map(Object.entries(init.dirs ?? {}).map(([name, mtimeMs]) => [`${DIR}/${name}`, mtimeMs]))
  const tools: Tool[] = []
  const commands: string[] = []
  const processes: { argv: string[]; stdin?: string }[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const isPlaced = init.isPlaced ?? true
  let seated = init.seated ?? isPlaced
  const waiting: (() => void)[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: e.name } }))
  on('command.register', (_$, e) => (commands.push(e.name), { value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  const clock = mock.clock(on, { now: init.now ?? 1_000 })
  let elapsed = 0
  const now = () => (init.now ?? 1_000) + elapsed
  on('fs.list', (_$, e) => {
    const prefix = `${e.path}/`
    const entries = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: false }>()
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue
      const [name = '', ...rest] = path.slice(prefix.length).split('/')
      const kind = rest.length === 0 ? ('file' as const) : ('dir' as const)
      entries.set(name, { name, kind, size: kind === 'file' ? file.text.length : 0, mtimeMs: dirs.get(`${prefix}${name}`) ?? file.mtimeMs, isLink: false })
    }
    for (const [path, mtimeMs] of dirs) {
      const name = path.slice(prefix.length)
      if (path.startsWith(prefix) && !name.includes('/') && !entries.has(name)) entries.set(name, { name, kind: 'dir', size: 0, mtimeMs, isLink: false })
    }
    if (entries.size === 0 && e.path !== DIR) return { deny: `ENOENT: ${e.path}` }
    return { value: [...entries.values()] }
  })
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path)!.text } : { deny: `ENOENT: ${e.path}` }))
  on('fs.write', (_$, e) => (files.set(e.path, { text: e.text, mtimeMs: now() }), { value: undefined }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    processes.push({ argv, stdin: e.init?.stdin })
    if (argv[0] === 'rm') {
      const path = argv.at(-1) ?? ''
      if (argv.includes('-rf')) {
        for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key)
        dirs.delete(path)
        return { value: done(0) }
      }
      const had = files.delete(path)
      return { value: done(had || argv.includes('-f') ? 0 : 1) }
    }
    if (argv[0] === 'sh' && argv[2] === 'echo $PPID') return { value: { ...done(0), stdout: `${PID}\n` } }
    // The write script: the file appears at its last argument, holding stdin
    if (argv[0] === 'sh') {
      const exitCode = init.writeExit ?? 0
      if (exitCode === 0) files.set(argv.at(-1) ?? '', { text: e.init?.stdin ?? '', mtimeMs: init.now ?? 1_000 })
      return { value: done(exitCode) }
    }
    return { value: done(0) }
  })
  on('ui.open', (_$, e) => (opened.push(e.id), { value: isPlaced ? ({ isPlaced: true } as const) : ({ isPlaced: false, reason: 'narrow' } as const) }))
  on('ui.panes', () => ({ value: [{ id: 'secrets', isPlaced: seated }] as never }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    for (const wake of waiting.splice(0)) wake()
    return { text: e.text }
  })

  /** Queues a request as the MCP server does, under the id `id`. */
  const request = (id: string, input: Record<string, unknown>) => files.set(`${QUEUE}/${id}.json`, { text: JSON.stringify(input), mtimeMs: now() })
  /** What the module answered the server for request `id`: where the card is, or undefined. */
  const ack = (id: string) => files.get(`${QUEUE}/${id}.ack`)?.text
  /** Moves the clock on in small steps until `done` holds, as the module's timers fire. */
  const until = async (done: () => boolean) => {
    for (let step = 0; step < 100 && !done(); step++) {
      await clock.advance(50)
      elapsed += 50
    }
  }

  return {
    tools,
    commands,
    request,
    ack,
    until,
    dirs,
    processes,
    submitted,
    toasts,
    opened,
    files,
    clock,
    /** A surface seats (or unseats) the pane, as ui.panes then tells. */
    seat: (value: boolean) => (seated = value),
    /** Resolves once the plugin has sent a message to the model. */
    submission: () => new Promise<void>((resolve) => (submitted.length ? resolve() : waiting.push(resolve))),
  }
}

/** Starts the session; the module serves no tool (the MCP server does), so `tools` stays empty. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<void> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools).toEqual([])
}
