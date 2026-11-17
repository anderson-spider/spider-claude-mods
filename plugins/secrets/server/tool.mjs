// The one tool the server lists: its input type, and its schema checked against that type by `SchemaFor`.
/** @import { SchemaFor } from '../hooks/schema.ts' */

/**
 * What the model sends to mcp__plugin_secrets_secrets__request_secret.
 * @typedef {{ name: string, label: string, reason?: string, steps?: string[], url?: string, format?: string }} RequestSecretInput
 */

/** @satisfies {SchemaFor<RequestSecretInput>} */
const INPUT_SCHEMA = /** @type {const} */ ({
  type: 'object',
  properties: {
    name: { type: 'string', description: 'What the value is called, e.g. CLOUDFLARE_API_TOKEN. Letters, digits, _ . - only.' },
    label: { type: 'string', description: 'The title of the card, e.g. "Cloudflare API token"' },
    reason: { type: 'string', description: 'Why it is needed, in under 12 words' },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description:
        '2-5 short imperative steps, one action each, naming the exact labels on screen. ' +
        'E.g. ["Open the Cloudflare dashboard", "Go to My Profile > API Tokens", "Copy the token"]',
    },
    url: { type: 'string', description: 'The https page where the value can be found or created' },
    format: { type: 'string', description: 'What a valid value looks like, e.g. "40 characters"' },
  },
  required: ['name', 'label'],
})

export const REQUEST_SECRET = {
  name: 'request_secret',
  description:
    'Asks the user for one secret (a token, a password, a pairing code) in a private card. You never see the ' +
    'value: it is saved to an owner-only file and you are sent its path in a message. Use it for a secret only ' +
    'the user has and the next step needs, never to ask in chat or in a question. One secret per request. ' +
    'Make the card easy to act on: the exact steps to find the value (what to click, what the field is ' +
    'labelled), the URL of the page, and what a valid value looks like. After calling this, stop and wait: ' +
    'you get a message once the value is saved or declined. Then use it only inside a command, as ' +
    'TOKEN="$(cat <file>)" cli, and never print, read, copy or write it anywhere else. If the user declines, ' +
    'say what is blocked and go on without it: do not ask in chat and do not retry. A secret the user ' +
    'already pasted in chat is not for this tool; do not call it when access already exists.',
  inputSchema: INPUT_SCHEMA,
}
