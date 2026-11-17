// A Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line), with no dependencies: it lists the
// orchestrator's tools and answers their calls side by side, with a progress beat on the call's token while one waits.
// Pure: the stream and the call are injected.

export const PROTOCOL = '2025-06-18'

/**
 * @typedef {{ type: 'text', text: string } | { type: 'image', data: string, mimeType: string }} Content
 * @typedef {{ content: Content[], isError?: true }} Reply
 * @typedef {{ name: string, description: string, inputSchema: object }} ToolSpec
 * @typedef {string | number} Id
 * @typedef {{ jsonrpc?: string, id?: Id | null, method?: string, params?: Record<string, unknown> }} Message
 * @typedef {{ progress: (message: string) => void }} CallContext
 * @typedef {object} ServerDeps
 * @property {readonly ToolSpec[]} tools
 * @property {(line: string) => void} write
 * @property {(name: string, input: Record<string, unknown>, context: CallContext) => Promise<Reply>} call
 * @property {(text: string) => void} [log] A line for the server's own log (stderr), never the client's channel.
 */

/**
 * @param {ServerDeps} deps
 * @returns {{ receive: (line: string) => Promise<void> }}
 */
export function server(deps) {
  /** @param {Record<string, unknown>} message */
  const send = (message) => deps.write(JSON.stringify({ jsonrpc: '2.0', ...message }))
  /** @type {(id: Id, result: unknown) => void} */
  const answer = (id, result) => send({ id, result })
  /** @type {(id: Id, code: number, message: string) => void} */
  const fail = (id, code, message) => send({ id, error: { code, message } })
  /** @type {ReadonlySet<string>} */
  const names = new Set(deps.tools.map((tool) => tool.name))

  /**
   * @param {Id} id
   * @param {Record<string, unknown>} params
   */
  async function call(id, params) {
    const name = params.name
    if (typeof name !== 'string' || !names.has(name)) return fail(id, -32602, `Unknown tool: ${String(name)}`)
    const args = params.arguments
    const input = args && typeof args === 'object' && !Array.isArray(args) ? /** @type {Record<string, unknown>} */ (args) : {}
    const token = /** @type {{ progressToken?: unknown } | undefined} */ (params._meta)?.progressToken
    let beats = 0
    /** @param {string} message */
    const progress = (message) => {
      if (typeof token === 'string' || typeof token === 'number') send({ method: 'notifications/progress', params: { progressToken: token, progress: ++beats, message } })
    }
    /** @type {Reply} */
    let reply
    try {
      reply = await deps.call(name, input, { progress })
    } catch (err) {
      deps.log?.(`orchestrator: ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      reply = { content: [{ type: 'text', text: 'The orchestrator tool failed before it could answer: its daemon did not reply. Try again; if it repeats, see daemon.log in ~/.local/state/spider-orchestrator.' }], isError: true }
    }
    answer(id, reply)
  }

  return {
    async receive(line) {
      if (!line.trim()) return
      /** @type {Message} */
      let message
      try {
        message = JSON.parse(line)
      } catch {
        return send({ id: null, error: { code: -32700, message: 'Parse error' } })
      }
      const { id, method } = message
      // A notification, or an answer to a request this server never sends: nothing to say.
      if (method === undefined || id === undefined || id === null) return
      const params = message.params ?? {}
      switch (method) {
        case 'initialize': {
          const asked = params.protocolVersion
          return answer(id, {
            protocolVersion: typeof asked === 'string' ? asked : PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'orchestrator', version: '1' },
          })
        }
        case 'ping':
          return answer(id, {})
        case 'tools/list':
          return answer(id, { tools: deps.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
        case 'tools/call':
          // Calls run side by side: a wait on one task does not hold the others.
          void call(id, params)
          return
        default:
          return fail(id, -32601, `Method not found: ${method}`)
      }
    },
  }
}
