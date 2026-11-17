// The hand-off between the plugin's MCP server, which takes Claude's request_secret call, and the session's hooks
// module, which draws the card. The server writes each checked request as a file in the session's queue and waits for
// an answer file that says where the card is. Both find the queue by the Claude Code process: the server is its child,
// and so is a command the module runs. Pure: nothing here touches the host.

/** The queues, inside the secrets folder, so the fence keeps the model's own tools out of them too. */
export function queuesDir(secretsDir: string): string {
  return `${secretsDir}/.requests`
}

/** One session's queue, named by the Claude Code process id. */
export function queueDir(secretsDir: string, pid: number): string {
  return `${queuesDir(secretsDir)}/${pid}`
}

const REQUEST = /^([0-9a-f]{16})\.json$/

export const requestFile = (id: string) => `${id}.json`
export const ackFile = (id: string) => `${id}.ack`

/** The id of a request file the server wrote whole, or undefined (a partial, an answer, a stray). */
export const idOf = (file: string) => REQUEST.exec(file)?.[1]

/** Whether a folder in the queues is named as a session's queue is. */
export const isPid = (name: string) => /^[1-9][0-9]{0,9}$/.test(name)

/** Where the module drew the card: the pane, or the band above the prompt while the pane waits for a wider terminal. */
export type Placement = 'pane' | 'band'

export function placementOf(text: unknown): Placement | undefined {
  const value = typeof text === 'string' ? text.trim() : ''
  return value === 'pane' || value === 'band' ? value : undefined
}

/** How long the server waits for the card, and how often it looks: the module takes the queue every TAKE_MS, then looks at the pane for about a second. */
export const ACK_WAIT_MS = 5_000
export const ACK_POLL_MS = 100
export const TAKE_MS = 500

/** Another session's queue untouched this long belongs to a session that ended. */
export const STALE_MS = 60 * 60 * 1000
