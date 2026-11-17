// JSON-RPC 2.0 over a byte stream, one message per line, both ways: the daemon's socket and an ACP agent's stdio.
// Pure: the stream is injected.

export class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   * @param {unknown} [data]
   */
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

/**
 * @typedef {object} PeerDeps
 * @property {(line: string) => void} write
 * @property {(method: string, params: any) => Promise<unknown>} [onRequest] Answers a request; a throw becomes its error.
 * @property {(method: string, params: any) => void} [onNotification]
 * @property {(text: string) => void} [log]
 */

/** @param {PeerDeps} deps */
export function peer(deps) {
  let next = 1
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
  const pending = new Map()
  let closed = /** @type {Error | undefined} */ (undefined)
  let buffer = ''

  /** @param {Record<string, unknown>} message */
  const send = (message) => {
    if (!closed) deps.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @returns {Promise<any>}
   */
  function request(method, params) {
    if (closed) return Promise.reject(closed)
    return new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      send({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  const notify = (method, params) => send({ method, ...(params === undefined ? {} : { params }) })

  /** @param {any} message */
  async function handle(message) {
    if (typeof message !== 'object' || message === null) return
    const { id, method } = message
    if (typeof method === 'string' && id !== undefined && id !== null) {
      try {
        if (!deps.onRequest) throw new RpcError(-32601, `Method not found: ${method}`)
        send({ id, result: (await deps.onRequest(method, message.params)) ?? null })
      } catch (error) {
        const code = error instanceof RpcError ? error.code : -32603
        send({ id, error: { code, message: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    if (typeof method === 'string') return deps.onNotification?.(method, message.params)
    const waiting = pending.get(id)
    if (!waiting) return
    pending.delete(id)
    if (message.error) waiting.reject(new RpcError(Number(message.error.code) || -32603, String(message.error.message ?? 'error'), message.error.data))
    else waiting.resolve(message.result)
  }

  return {
    request,
    notify,
    /** @param {string} chunk */
    feed(chunk) {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim()
        buffer = buffer.slice(at + 1)
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          // An agent may print sign-in or update text on stdout: it is not the protocol's.
          deps.log?.(`not JSON-RPC: ${line.slice(0, 200)}`)
          continue
        }
        void handle(message)
      }
    },
    /** @param {Error} error */
    close(error) {
      closed ??= error
      for (const waiting of pending.values()) waiting.reject(error)
      pending.clear()
    },
  }
}
