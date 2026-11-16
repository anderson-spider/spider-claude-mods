import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, McpToolInputs, Register } from 'claude-code'

import type { SecretRequest } from '../types'
import { DENY, ancestors, bashReason, forms, toolReason } from './guard'
import {
  NO_FOLDER,
  askedMessage,
  declinedMessage,
  enqueue,
  failedMessage,
  parseRequest,
  savedMessage,
  type RequestInput,
} from './request'
import { buildIndex, scrubBlock, scrub, type Block, type Index } from './scrub'
import { type SchemaFor } from './schema'
import { fileName, isExpired, nameOf, randomSuffix, secretsDir, writeArgv } from './store'

const PANE = 'secrets'
const TOOL = 'mcp__secrets__'
const HOUR = 60 * 60 * 1000
// A surface may seat the pane a moment after ui.open said it waits, so the request looks again, briefly, before it says so
const SEAT_CHECKS = 4
const SEAT_WAIT_MS = 250

const requests = atom({ plugin: 'secrets', key: 'requests' } as const, [] as SecretRequest[])
const isWaiting = atom({ plugin: 'secrets', key: 'isWaiting' } as const, false)

// What the scrubber knows: each live saved value and the name it was saved under. Rebuilt from the
// folder at session start and every hour, so a reload or a resumed session loses nothing.
let values = new Map<string, string>()
let index: Index = []
let cwd: string | undefined

/** The private folder, or undefined where no home is known. */
async function folder($: EngineInterface): Promise<string | undefined> {
  return secretsDir({ home: await $.env.get('HOME'), configDir: await $.env.get('CLAUDE_CONFIG_DIR') })
}

/** Whether a surface draws the pane now, asked again a few times over a moment: `ui.open` can answer undrawn just before the surface seats it. */
async function isDrawn($: EngineInterface): Promise<boolean> {
  for (let check = 1; ; check++) {
    const pane = (await $.ui.panes()).find((p) => p.id === PANE)
    if (pane?.isPlaced) return true
    if (check === SEAT_CHECKS) return false
    await $.clock.sleep(SEAT_WAIT_MS)
  }
}

/** Deletes the files past their day and rebuilds the scrubber's index from the ones left. */
async function refresh($: EngineInterface): Promise<void> {
  const dir = await folder($)
  if (!dir) return
  const entries = await $.fs.list(dir).catch(() => [])
  const now = await $.clock.now()
  const live = new Map<string, string>()
  for (const entry of entries) {
    const name = nameOf(entry.name)
    if (entry.kind !== 'file' || name === undefined) continue
    const path = `${dir}/${entry.name}`
    if (isExpired(entry.mtimeMs, now)) {
      await $.process.run(['rm', '-f', path]).catch(() => undefined)
      continue
    }
    const value = await $.fs.read(path).catch(() => undefined)
    if (typeof value === 'string' && value !== '') live.set(value, name)
  }
  values = live
  index = buildIndex(values)
}

/** Ends the card in front: saves the value to a private file, or tells Claude it was declined. */
async function answer($: EngineInterface, how: 'save' | 'decline' | 'close', value = ''): Promise<void> {
  const [asked, ...rest] = await read($, requests)
  if (!asked) return
  await update($, requests, () => rest)
  if (rest.length === 0) await update($, isWaiting, () => false)

  if (how !== 'save') {
    void $.prompt.submit({ text: declinedMessage(asked.name, how === 'close' ? 'closed the pane' : 'declined') })
    return
  }
  const dir = await folder($)
  const file = fileName(asked.name, randomSuffix())
  // The value goes in on stdin, never in the command line
  const run = dir ? await $.process.run(writeArgv(dir, file), { stdin: value }).catch(() => undefined) : undefined
  if (!dir || !run || run.exitCode !== 0) {
    void $.prompt.submit({ text: failedMessage(asked.name) })
    return
  }
  values.set(value, asked.name)
  index = buildIndex(values)
  $.ui.toast(`Saved ${asked.name} in a private file`)
  void $.prompt.submit({ text: savedMessage(asked.name, `${dir}/${file}`) })
}

/** The card Claude's request draws: what, why, where to find it, and the field to paste into. In the pane, or in the band above the prompt while the pane waits for a wider terminal. */
function card(
  $: EngineInterface,
  ui: ElementTable<'terminal' | 'desktop'>,
  asked: SecretRequest,
  more: number,
  where: 'pane' | 'band',
) {
  const { Box, Text, Button, Input, Markdown } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={where === 'pane' ? 1 : 0}>
      <Text bold color="yellow">
        Claude needs a secret
      </Text>
      <Box gap={1} marginTop={1}>
        <Text bold>{asked.label}</Text>
        <Text dimColor>({asked.name})</Text>
      </Box>
      {asked.reason !== '' && <Text wrap="wrap">{asked.reason}</Text>}

      {asked.steps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {asked.steps.map((step, i) => (
            <Box key={`step:${i}`} gap={1}>
              <Text bold color="yellow">
                {String(i + 1)}.
              </Text>
              <Text wrap="wrap">{step}</Text>
            </Box>
          ))}
        </Box>
      )}

      {asked.url && (
        <Box gap={1} marginTop={1}>
          <Markdown text={`[${asked.url}](${asked.url})`} />
          <Button key="copy-url" label="copy link" plain dimColor onPress={(press) => void $.ui.copy({ text: asked.url ?? '', surface: press.surface })} />
        </Box>
      )}
      {asked.format && <Text dimColor>Looks like: {asked.format}</Text>}

      <Box marginTop={1}>
        <Input
          key="secret"
          label="Paste ▸ "
          placeholder={`${asked.name}, then Enter`}
          submitLabel="save"
          autoFocus
          onSubmit={(value) => {
            if (value.trim() !== '') void answer($, 'save', value.trim())
          }}
        />
      </Box>
      <Text dimColor>It goes to a private file Claude only reads inside a command. The field is not masked: it shows until you press Enter.</Text>
      <Box gap={1} marginTop={1}>
        <Button key="decline" label="decline" plain dimColor onPress={() => void answer($, 'decline')} />
        {more > 0 && <Text dimColor>{String(more)} more waiting</Text>}
        {where === 'band' && (
          <Button
            key="open-pane"
            label="open /secrets pane"
            plain
            dimColor
            onPress={async () => {
              const opened = await $.ui.open({ id: PANE, title: 'secrets', focus: true })
              await update($, isWaiting, () => !opened.isPlaced)
            }}
          />
        )}
      </Box>
      {where === 'band' && <Text dimColor>Click the field or press ctrl+x tab to paste.</Text>}
    </Box>
  )
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await refresh($)

    await $.command.register({
      name: 'secrets',
      description: 'Open the pane where Claude asks for secrets',
      immediate: true,
    })

    await $.tool.register({
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
      inputSchema: {
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
      } satisfies SchemaFor<McpToolInputs['mcp__secrets__request_secret']>,
    })

    // A waiting pane is placed once the terminal widens to its floor
    $.clock.every(2000, () => {
      void $.ui.panes().then(async (panes) => {
        const pane = panes.find((p) => p.id === PANE)
        const waiting = pane !== undefined && !pane.isPlaced
        if (waiting !== (await read($, isWaiting))) await update($, isWaiting, () => waiting)
      })
    })
    $.clock.every(HOUR, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'secrets' }, async ($) => {
    const opened = await $.ui.open({ id: PANE, title: 'secrets', focus: true })
    await update($, isWaiting, () => !opened.isPlaced)
    return { text: 'Opened the secrets pane.' }
  })

  // Closing the pane is an answer: Claude is told, so it does not wait on a card nobody will fill
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      await update($, isWaiting, () => false)
      if (e.origin.kind === 'person') {
        for (const _ of await read($, requests)) await answer($, 'close')
      }
    }
    return next(e)
  })

  // The fence: keep the model's own tools away from the saved files
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith(TOOL)) return next(e)
    const dir = await folder($)
    if (!dir) return next(e)
    const home = await $.env.get('HOME')
    const input = e as unknown as Record<string, unknown>

    const reason =
      tool === 'Bash' && typeof input.command === 'string'
        ? bashReason(input.command, forms(dir, home), ancestors(dir, home))
        : toolReason(tool, input, dir, home, cwd)
    return reason ? { deny: `${DENY} (Blocked because ${reason}.)` } : next(e)
  })

  // The backstop: any saved value that reaches the conversation by any route is replaced
  // with [secret:NAME] before the row is stored or sent
  on('session.append', ($, e, next) => {
    if (index.length === 0) return next(e)
    const content = e.message.content.map((block) => scrubBlock(block as Block, index))
    const isChanged = content.some((block, i) => block !== (e.message.content[i] as unknown))
    return isChanged ? next({ ...e, message: { ...e.message, content } as typeof e.message }) : next(e)
  })

  on('session.send', ($, e, next) => (index.length === 0 ? next(e) : next({ ...e, text: scrub(e.text, index) })))

  on('tool.call', { tool: 'mcp__secrets__request_secret' }, async ($, e) => {
    const asked = parseRequest(e as unknown as RequestInput)
    if ('error' in asked) return { result: asked.error, isError: true as const }
    if (!(await folder($))) return { result: NO_FOLDER, isError: true as const }

    await update($, requests, (queue) => enqueue(queue, asked))
    // Opened by Claude, not the person, so a narrow terminal leaves the pane waiting undrawn;
    // the card then shows in the band above the prompt
    const opened = await $.ui.open({ id: PANE, title: 'secrets', focus: true })
    // Only when it is still undrawn after looking again does Claude say the card is above the prompt
    const isPlaced = opened.isPlaced || (await isDrawn($))
    await update($, isWaiting, () => !isPlaced)
    $.ui.toast(isPlaced ? `Claude needs ${asked.name}` : `Claude needs ${asked.name}: paste it above the prompt`)
    return { result: askedMessage(asked.name, isPlaced) }
  })

  // While the pane waits for a wider terminal, Claude's request shows here
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    if (e.props.hasSurvey || !(await read($, isWaiting))) return next(e)
    const [asked, ...rest] = await read($, requests)
    if (!asked) return next(e)
    // isWaiting trails the surface by up to a poll; ask the surface itself so the card
    // leaves the moment the pane is placed
    const pane = (await $.ui.panes()).find((p) => p.id === PANE)
    if (!pane || pane.isPlaced) return next(e)
    return card($, $.ui.resolve(e), asked, rest.length, 'band')
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>Open a terminal or the desktop app to answer a secret request.</Text>
    }
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const [asked, ...rest] = await read($, requests)
    if (asked) return card($, ui, asked, rest.length, 'pane')
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>No secret is being asked for.</Text>
        <Text dimColor wrap="wrap">
          When Claude needs a token or a password it asks here, and you paste it into a private file Claude can use but not read.
        </Text>
      </Box>
    )
  })
}
