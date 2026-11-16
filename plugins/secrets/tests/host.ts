// The host fake the plugin's tests share: answers the events around the plugin, records what it
// registers, runs, shows and sends, and keeps a small file system for the secrets folder.
import type { On } from 'claude-code'
import { expect, mock } from 'claude-code/testing'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__secrets__${name}`

export const HOME = '/home/me'
export const DIR = `${HOME}/.claude/secrets`

const done = (exitCode: number) => ({ exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

export type Init = {
  /** The folder's files: name to text and age in ms (default 0). */
  files?: Record<string, { text: string; mtimeMs?: number }>
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
  const tools: Tool[] = []
  const commands: string[] = []
  const processes: { argv: string[]; stdin?: string }[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  const opened: string[] = []
  const isPlaced = init.isPlaced ?? true
  let seated = init.seated ?? isPlaced
  const waiting: (() => void)[] = []

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('command.register', (_$, e) => (commands.push(e.name), { value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  const clock = mock.clock(on, { now: init.now ?? 1_000 })
  on('fs.list', (_$, e) => {
    if (e.path !== DIR) return { deny: `ENOENT: ${e.path}` }
    return {
      value: [...files].map(([path, file]) => ({
        name: path.slice(DIR.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
    }
  })
  on('fs.read', (_$, e) => (files.has(e.path) ? { value: files.get(e.path)!.text } : { deny: `ENOENT: ${e.path}` }))
  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    processes.push({ argv, stdin: e.init?.stdin })
    if (argv[0] === 'rm') {
      files.delete(argv.at(-1) ?? '')
      return { value: done(0) }
    }
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

  return {
    tools,
    commands,
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

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}
