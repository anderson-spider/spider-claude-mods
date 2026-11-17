import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { SecretRequest } from '../types'
import { STALE_MS, TAKE_MS, ackFile, idOf, isPid, queueDir, queuesDir, type Placement } from './queue'
import { declinedMessage, enqueue, failedMessage, parseQueued, savedMessage } from './request'
import { buildIndex, scrubBlock, type Block, type Index } from './scrub'
import { fileName, isExpired, nameOf, randomSuffix, secretsDir, writeArgv } from './store'

const PANE = 'secrets'
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
// The Claude Code process, whose id names this session's queue: the plugin's MCP server is its child too
let pid: number | undefined
let isTaking = false

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

  // Queues left by sessions that ended
  for (const entry of await $.fs.list(queuesDir(dir)).catch(() => [])) {
    if (entry.kind !== 'dir' || !isPid(entry.name) || Number(entry.name) === pid || now - entry.mtimeMs < STALE_MS) continue
    await $.process.run(['rm', '-rf', '--', `${queuesDir(dir)}/${entry.name}`]).catch(() => undefined)
  }
}

/** The Claude Code process: the parent of a command this module runs, as it is of the MCP server. */
async function claudePid($: EngineInterface): Promise<number | undefined> {
  const run = await $.process.run(['sh', '-c', 'echo $PPID']).catch(() => undefined)
  const found = Number(run?.stdout.trim())
  return Number.isInteger(found) && found > 1 ? found : undefined
}

/** Queues the request, opens the pane and says where the card is: the pane, or the band while a narrow terminal leaves the pane undrawn. */
async function show($: EngineInterface, asked: SecretRequest): Promise<Placement> {
  await update($, requests, (queue) => enqueue(queue, asked))
  // Opened by Claude, not the person, so a narrow terminal leaves the pane waiting undrawn;
  // the card then shows in the band above the prompt
  const opened = await $.ui.open({ id: PANE, title: 'secrets', focus: true })
  // Only when it is still undrawn after looking again does Claude hear the card is above the prompt
  const isPlaced = opened.isPlaced || (await isDrawn($))
  await update($, isWaiting, () => !isPlaced)
  $.ui.toast(isPlaced ? `Claude needs ${asked.name}` : `Claude needs ${asked.name}: paste it above the prompt`)
  return isPlaced ? 'pane' : 'band'
}

/** Takes the requests the MCP server queued for this session, oldest first: each is shown, and the server told where. */
async function take($: EngineInterface): Promise<void> {
  if (isTaking || pid === undefined) return
  const dir = await folder($)
  if (!dir) return
  isTaking = true
  try {
    const queue = queueDir(dir, pid)
    const entries = (await $.fs.list(queue).catch(() => []))
      .filter((entry) => entry.kind === 'file' && idOf(entry.name) !== undefined)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of entries) {
      const path = `${queue}/${entry.name}`
      const text = await $.fs.read(path).catch(() => undefined)
      // Taken: the server withdraws only a request still there when its wait ends
      const removed = await $.process.run(['rm', '--', path]).catch(() => undefined)
      const asked = typeof text === 'string' && removed?.exitCode === 0 ? parseQueued(text) : undefined
      if (!asked) continue
      const placement = await show($, asked)
      await $.fs.write(`${queue}/${ackFile(idOf(entry.name) ?? '')}`, placement).catch(() => undefined)
    }
  } finally {
    isTaking = false
  }
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
    pid = await claudePid($)
    await refresh($)

    await $.command.register({
      name: 'secrets',
      description: 'Open the pane where Claude asks for secrets',
      immediate: true,
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
    // Claude's requests, which the plugin's MCP server queues for this session
    $.clock.every(TAKE_MS, () => void take($))

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


  // The backstop: any saved value that reaches the conversation by any route is replaced
  // with [secret:NAME] before the row is stored or sent
  on('session.append', ($, e, next) => {
    if (index.length === 0) return next(e)
    const content = e.message.content.map((block) => scrubBlock(block as Block, index))
    const isChanged = content.some((block, i) => block !== (e.message.content[i] as unknown))
    return isChanged ? next({ ...e, message: { ...e.message, content } as typeof e.message }) : next(e)
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
