// A Model Context Protocol server over stdio (JSON-RPC 2.0, one message per line), with no dependencies: it lists the
// plugin's tools and answers their calls. Pure: the stream and the call are injected.

export const PROTOCOL = '2025-06-18'

/**
 * @typedef {{ text: string, isError?: true }} Reply
 * @typedef {{ name: string, description: string, inputSchema: object }} ToolSpec
 * @typedef {string | number} Id
 * @typedef {{ jsonrpc?: string, id?: Id | null, method?: string, params?: Record<string, unknown> }} Message
 * @typedef {object} ServerDeps
 * @property {readonly ToolSpec[]} tools
 * @property {(line: string) => void} write
 * @property {(name: string, input: Record<string, unknown>) => Promise<Reply>} call
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
    /** @type {Reply} */
    let reply
    try {
      reply = await deps.call(name, input)
    } catch (err) {
      deps.log?.(`secrets: ${name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      reply = { text: 'The secrets tool failed before it could answer. Do not ask for the secret in chat: tell the user what is blocked.', isError: true }
    }
    answer(id, { content: [{ type: 'text', text: reply.text }], ...(reply.isError ? { isError: true } : {}) })
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
            serverInfo: { name: 'secrets', version: '1' },
          })
        }
        case 'ping':
          return answer(id, {})
        case 'tools/list':
          return answer(id, { tools: deps.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
        case 'tools/call':
          // Calls run side by side: one waiting for its card does not hold another.
          void call(id, params)
          return
        default:
          return fail(id, -32601, `Method not found: ${method}`)
      }
    },
  }
}
