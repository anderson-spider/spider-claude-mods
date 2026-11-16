// What the model asks for and what it is told back. Pure: nothing here touches the host.
import type { SecretRequest } from '../types'
import { NAME } from './store'

/** The tool's input as the model may send it: nothing is trusted until checked here. */
export type RequestInput = {
  name?: unknown
  label?: unknown
  reason?: unknown
  steps?: unknown
  url?: unknown
  format?: unknown
}

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined

/** The checked request, or the reason it is refused (the model reads it as the tool's result). */
export function parseRequest(input: RequestInput): SecretRequest | { error: string } {
  const name = typeof input.name === 'string' ? input.name : ''
  if (!NAME.test(name)) {
    return { error: `"${name}" is not a valid name: start with a letter or _, then letters, digits, _ . - (64 at most), e.g. CLOUDFLARE_API_TOKEN.` }
  }
  const label = clip(input.label, 80)
  if (!label) return { error: 'label is required: the title of the card, such as "Cloudflare API token".' }
  const url = clip(input.url, 300)
  return {
    name,
    label,
    reason: clip(input.reason, 200) ?? '',
    steps: Array.isArray(input.steps) ? input.steps.map((step) => String(step).slice(0, 160)).filter((step) => step.trim() !== '').slice(0, 5) : [],
    url: url && /^https?:\/\/[^\s]+$/.test(url) ? url : undefined,
    format: clip(input.format, 80),
  }
}

/** The queue after a new request: one card a name, the newest asking replaces an older one of the same name. */
export function enqueue(queue: readonly SecretRequest[], request: SecretRequest): SecretRequest[] {
  return [...queue.filter((asked) => asked.name !== request.name), request]
}

const WAIT = 'Stop here and wait: you will get a message once it is saved, declined or the pane is closed. Do not ask for it in chat.'

/** What the tool answers at once. A narrow terminal leaves the pane undrawn, so the card shows above the prompt. */
export function askedMessage(name: string, isPlaced: boolean): string {
  if (isPlaced) return `Asked the user for ${name} in the secrets pane. ${WAIT}`
  return (
    `The terminal is too narrow for the secrets pane to open on its own, so the request for ${name} shows as a card above the prompt. ` +
    `Tell the user in one line to paste it there, or type /secrets to open the full pane. ${WAIT}`
  )
}

export const NO_FOLDER =
  'No home folder was found for the private secrets folder, so nothing can be saved. Do not ask for the secret in chat: tell the user what is blocked and carry on without it.'

export function savedMessage(name: string, file: string): string {
  return (
    `[secrets] The user saved ${name}. It is in the private file ${file}. Use it only inside a command, as "$(cat ${file})", ` +
    `for example TOKEN="$(cat ${file})" the-cli. Never print it, read it with another tool, copy it, or put it in a note, a brief or a commit. ` +
    'The file is deleted after 24 hours: ask again with a new request if it is needed later. Continue.'
  )
}

export function declinedMessage(name: string, how: 'declined' | 'closed the pane'): string {
  const did = how === 'declined' ? 'declined to provide' : 'closed the pane without providing'
  return `[secrets] The user ${did} ${name}. Do not ask for it in chat or another way, and do not retry. Say what is blocked and go on without it.`
}

export function failedMessage(name: string): string {
  return `[secrets] Could not save ${name}: the private file could not be written. Nothing was stored. Tell the user, and do not ask for the value in chat.`
}
