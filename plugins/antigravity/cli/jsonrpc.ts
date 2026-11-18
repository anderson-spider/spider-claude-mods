// JSON-RPC 2.0 over a byte stream, one message per line both ways: an ACP agent's stdio. Pure: the stream is injected.

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.data = data
  }
}

export interface PeerDeps {
  write: (line: string) => void
  /** Answers a request; a throw becomes its error. */
  onRequest?: (method: string, params: any) => Promise<unknown>
  onNotification?: (method: string, params: any) => void
  log?: (text: string) => void
}

export interface Peer {
  request: (method: string, params?: unknown) => Promise<any>
  notify: (method: string, params?: unknown) => void
  feed: (chunk: string) => void
  close: (error: Error) => void
}

export function peer(deps: PeerDeps): Peer {
  let next = 1
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let closed: Error | undefined
  let buffer = ''

  const send = (message: Record<string, unknown>) => {
    if (!closed) deps.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }

  function request(method: string, params?: unknown): Promise<any> {
    if (closed) return Promise.reject(closed)
    return new Promise((resolve, reject) => {
      const id = next++
      pending.set(id, { resolve, reject })
      send({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  const notify = (method: string, params?: unknown) => send({ method, ...(params === undefined ? {} : { params }) })

  async function handle(message: any) {
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
    close(error) {
      closed ??= error
      for (const waiting of pending.values()) waiting.reject(error)
      pending.clear()
    },
  }
}
