// A Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line), with no dependencies: it lists the
// six tools and answers their calls. The client's roots name the session's folder, read again when the client says they
// changed, so git runs where the session works. Pure: the streams, the folder's handlers and the call are injected.
import { SPECS, type ToolSpec } from './tools.ts'
import type { Reply } from './run.ts'

export const PROTOCOL = '2025-06-18'

type Id = string | number
type Message = { jsonrpc?: string; id?: Id | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

/** What a tool call gets beyond its input: the session's folder, and a beat that keeps a long call alive. */
export type CallContext = { cwd: string | undefined; progress: (message: string) => void }

export type Server = {
  /** Handles one line from the client; answers through `write`. */
  receive: (line: string) => Promise<void>
}

export type ServerDeps = {
  write: (line: string) => void
  call: (name: ToolSpec['name'], input: Record<string, unknown>, context: CallContext) => Promise<Reply>
  /** A line for the server's own log (stderr), never the client's channel. */
  log?: (text: string) => void
  /** How long a roots request waits before the call goes on with the last folder known. */
  rootsTimeoutMs?: number
}

const NAMES: ReadonlySet<string> = new Set(SPECS.map(spec => spec.name))

/** The folder of the first `file:` root, or undefined. */
export function folderOf(roots: unknown): string | undefined {
  const list = (roots as { roots?: unknown } | undefined)?.roots
  const uri = Array.isArray(list) ? (list[0] as { uri?: unknown } | undefined)?.uri : undefined
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return undefined
  try {
    return decodeURIComponent(new URL(uri).pathname)
  } catch {
    return undefined
  }
}

export function server(deps: ServerDeps): Server {
  const send = (message: Record<string, unknown>) => deps.write(JSON.stringify({ jsonrpc: '2.0', ...message }))
  const answer = (id: Id, result: unknown) => send({ id, result })
  const fail = (id: Id, code: number, message: string) => send({ id, error: { code, message } })

  let rootsSupported = false
  let cwd: string | undefined
  let stale = true
  let next = 0
  const pending = new Map<Id, (message: Message) => void>()

  /** The session's folder: asked once, and again after the client says its roots changed; on no answer, the last one. */
  async function folder(): Promise<string | undefined> {
    if (!rootsSupported || !stale) return cwd
    const id = `roots-${++next}`
    const reply = await new Promise<Message | undefined>(resolve => {
      const timer = setTimeout(() => { pending.delete(id); resolve(undefined) }, deps.rootsTimeoutMs ?? 2_000)
      pending.set(id, message => { clearTimeout(timer); resolve(message) })
      send({ id, method: 'roots/list' })
    })
    const found = reply && 'result' in reply ? folderOf(reply.result) : undefined
    if (found) {
      cwd = found
      stale = false
    }
    return cwd
  }

  async function call(id: Id, params: Record<string, unknown>): Promise<void> {
    const name = params.name
    if (typeof name !== 'string' || !NAMES.has(name)) return fail(id, -32602, `Unknown tool: ${String(name)}`)
    const args = params.arguments
    const input = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
    const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken
    let beats = 0
    const progress = (message: string) => {
      if (typeof token === 'string' || typeof token === 'number') send({ method: 'notifications/progress', params: { progressToken: token, progress: ++beats, message } })
    }
    let reply: Reply
    try {
      reply = await deps.call(name as ToolSpec['name'], input, { cwd: await folder(), progress })
    } catch (err) {
      deps.log?.(`gitlab: ${name} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      reply = { text: 'The gitlab tool failed before it could answer. Try again; if it repeats, run claude --debug.', isError: true }
    }
    answer(id, { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) })
  }

  return {
    async receive(line) {
      if (!line.trim()) return
      let message: Message
      try {
        message = JSON.parse(line) as Message
      } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const { id, method } = message
      // An answer to a request of ours (roots/list).
      if (method === undefined) {
        if (id !== undefined && id !== null) pending.get(id)?.(message)
        if (id !== undefined && id !== null) pending.delete(id)
        return
      }
      if (method === 'notifications/roots/list_changed') {
        stale = true
        return
      }
      // Any other notification needs no answer.
      if (id === undefined || id === null) return
      const params = message.params ?? {}
      switch (method) {
        case 'initialize': {
          rootsSupported = !!(params.capabilities as { roots?: unknown } | undefined)?.roots
          const asked = params.protocolVersion
          return answer(id, {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'gitlab', version: '1' },
          })
        }
        case 'ping':
          return answer(id, {})
        case 'tools/list':
          return answer(id, { tools: SPECS.map(spec => ({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema })) })
        case 'tools/call':
          // Calls run side by side: one waiting on a pipeline does not hold the others.
          void call(id, params)
          return
        default:
          return fail(id, -32601, `Method not found: ${method}`)
      }
    },
  }
}
