// request_secret: checks the request, queues it for the session's hooks module, which draws the card, and answers once
// the module says where the card is. It never waits for the user. Pure: the files, clock and ids are injected.
import { ACK_POLL_MS, ACK_WAIT_MS, ackFile, placementOf, queueDir, requestFile } from '../hooks/queue.ts'
import { NO_FOLDER, NO_PANE, askedMessage, parseRequest } from '../hooks/request.ts'
import { secretsDir } from '../hooks/store.ts'

/**
 * @import { Reply } from './mcp.mjs'
 * @import { RequestInput } from '../hooks/request.ts'
 * @typedef {object} AskDeps
 * @property {{ home?: string, configDir?: string }} env
 * @property {number} pid The Claude Code process, which names the session's queue.
 * @property {(dir: string, file: string, text: string) => Promise<void>} write Writes `text` to `dir/file`, owner-only, the folders made owner-only too; the file shows under its name only once whole.
 * @property {(path: string) => Promise<string | undefined>} read A file's text, or undefined when it is not there.
 * @property {(path: string) => Promise<boolean>} remove Removes a file; true when it was there.
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} now
 * @property {() => string} random 16 random hex digits.
 */

/**
 * @param {AskDeps} deps
 * @param {RequestInput} input
 * @returns {Promise<Reply>}
 */
export async function ask(deps, input) {
  const asked = parseRequest(input)
  if ('error' in asked) return { text: asked.error, isError: true }
  const dir = secretsDir(deps.env)
  if (!dir) return { text: NO_FOLDER, isError: true }

  const queue = queueDir(dir, deps.pid)
  const id = deps.random()
  await deps.write(queue, requestFile(id), JSON.stringify(asked))

  const ack = `${queue}/${ackFile(id)}`
  const until = deps.now() + ACK_WAIT_MS
  for (;;) {
    const placement = placementOf(await deps.read(ack))
    if (placement) {
      await deps.remove(ack)
      return { text: askedMessage(asked.name, placement === 'pane') }
    }
    if (deps.now() >= until) break
    await deps.sleep(ACK_POLL_MS)
  }
  // No answer: a request still queued was never taken, so it is withdrawn and no card shows later for it.
  // One taken without an answer is on screen.
  if (await deps.remove(`${queue}/${requestFile(id)}`)) return { text: NO_PANE, isError: true }
  return { text: askedMessage(asked.name, true) }
}
