import { expect, mock, test } from 'claude-code/testing'
import { DIR, QUEUE, started, world } from './host'

const VALUE = 'cf-token-0123456789'
const PANE = {
  plugin: 'secrets',
  component: 'Pane',
  requestId: 'secrets',
  props: { title: 'secrets', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const ASK = { name: 'CF_TOKEN', label: 'Cloudflare token', reason: 'Wrangler deploys the worker', steps: ['Open the dashboard'] }
const ID = '0123456789abcdef'
const ID2 = 'fedcba9876543210'

test('session start registers the /secrets command and serves no tool, which the MCP server does', async ($, on) => {
  const { tools, commands } = world(on)

  await started($, tools)

  expect(commands).toEqual(['secrets'])
})

test('a request the server queued opens the pane, and the server is told the card is in the pane', async ($, on) => {
  const w = world(on)
  await started($, w.tools)

  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)

  expect(w.ack(ID)).toBe('pane')
  expect(w.opened).toEqual(['secrets'])
  expect(w.toasts).toEqual(['Claude needs CF_TOKEN'])
  expect(w.files.has(`${QUEUE}/${ID}.json`)).toBe(false)
  expect(w.submitted).toEqual([])
})

test('a terminal too narrow for the pane shows the card above the prompt, and the server is told so, after looking again', async ($, on) => {
  const w = world(on, { isPlaced: false })
  await started($, w.tools)

  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)

  expect(w.ack(ID)).toBe('band')
  expect(w.toasts).toEqual(['Claude needs CF_TOKEN: paste it above the prompt'])
})

test('a pane the surface already seats when the module looks again is not called too narrow', async ($, on) => {
  const w = world(on, { isPlaced: false, seated: true })
  await started($, w.tools)

  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)

  expect(w.ack(ID)).toBe('pane')
  expect(w.toasts).toEqual(['Claude needs CF_TOKEN'])
})

test('a pane the surface seats a moment after ui.open answered is not called too narrow', async ($, on) => {
  const w = world(on, { isPlaced: false })
  await started($, w.tools)

  w.request(ID, ASK)
  await w.until(() => w.opened.length > 0)
  w.seat(true)
  await w.until(() => w.ack(ID) !== undefined)

  expect(w.ack(ID)).toBe('pane')
  expect(w.toasts).toEqual(['Claude needs CF_TOKEN'])
})

test('a request file that does not check out is dropped, opens nothing and gets no answer', async ($, on) => {
  const w = world(on)
  await started($, w.tools)

  w.request(ID, { name: '../x', label: 'x' })
  w.files.set(`${QUEUE}/${ID2}.json`, { text: 'not json', mtimeMs: 0 })
  await w.until(() => !w.files.has(`${QUEUE}/${ID}.json`) && !w.files.has(`${QUEUE}/${ID2}.json`))
  await w.until(() => false)

  expect(w.opened).toEqual([])
  expect(w.ack(ID)).toBeUndefined()
  expect(w.ack(ID2)).toBeUndefined()
})

test('only this session\'s queue is taken: another Claude Code process\'s request is left for it', async ($, on) => {
  const other = `${DIR}/.requests/777/${ID}.json`
  const w = world(on, { files: { [`.requests/777/${ID}.json`]: { text: JSON.stringify(ASK), mtimeMs: 1_000 } } })
  await started($, w.tools)

  await w.until(() => false)

  expect(w.opened).toEqual([])
  expect(w.files.has(other)).toBe(true)
})

test('the value pasted in the card goes to a private file on stdin and Claude is sent its path', async ($, on) => {
  const w = world(on)
  await started($, w.tools)

  // one round on each surface, each with its own request
  for (const [round, surface] of (['terminal', 'desktop'] as const).entries()) {
    const name = `CF_TOKEN_${round}`
    const id = round === 0 ? ID : ID2
    w.request(id, { ...ASK, name })
    await w.until(() => w.ack(id) !== undefined)
    w.submitted.length = 0

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Claude needs a secret/ }))?.text).toBe('Claude needs a secret')
    await ui.input({ key: 'secret', text: `  ${VALUE}  ` })
    await w.submission()

    const write = w.processes.filter((run) => run.argv[0] === 'sh' && run.argv[2] !== 'echo $PPID').at(-1)
    expect(write?.stdin).toBe(VALUE)
    // the value is on stdin only: nowhere in the command line, nor in what Claude is sent
    expect(write?.argv.join(' ')).not.toContain(VALUE)
    const file = write?.argv.at(-1) ?? ''
    expect(file).toMatch(new RegExp(`^${DIR}/${name}\\.[0-9a-f]{16}$`))
    expect(w.files.get(file)?.text).toBe(VALUE)
    expect(w.submitted).toHaveLength(1)
    expect(w.submitted[0]).toContain(`"$(cat ${file})"`)
    expect(w.submitted[0]).not.toContain(VALUE)

    // the request is answered: the pane is idle again
    expect(await ui.find({ type: 'Text', text: /No secret is being asked for/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty paste saves nothing and keeps the card', async ($, on) => {
  const w = world(on)
  await started($, w.tools)
  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'secret', text: '   ' })

  expect(w.processes.filter((run) => run.argv[0] === 'sh' && run.argv[2] !== 'echo $PPID')).toEqual([])
  expect(w.submitted).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Claude needs a secret/ })).toBeDefined()
  await ui.unmount()
})

test('declining tells Claude not to ask in chat or retry, and stores nothing', async ($, on) => {
  const w = world(on)
  await started($, w.tools)
  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'decline' })
  await w.submission()

  expect(w.submitted[0]).toContain('declined to provide CF_TOKEN')
  expect(w.submitted[0]).toContain('do not retry')
  expect(w.processes.filter((run) => run.argv[0] === 'sh' && run.argv[2] !== 'echo $PPID')).toEqual([])
  await ui.unmount()
})

test('a write that fails tells Claude nothing was stored', async ($, on) => {
  const w = world(on, { writeExit: 1 })
  await started($, w.tools)
  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'secret', text: VALUE })
  await w.submission()

  expect(w.submitted[0]).toContain('Nothing was stored')
  expect(w.submitted[0]).not.toContain(VALUE)
  expect([...w.files.keys()].filter((path) => !path.startsWith(`${QUEUE}/`))).toEqual([])
  await ui.unmount()
})

test('requests wait in line, one card at a time, in the order asked', async ($, on) => {
  const w = world(on)
  await started($, w.tools)
  w.request(ID, ASK)
  await w.until(() => w.ack(ID) !== undefined)
  w.request(ID2, { name: 'GH_TOKEN', label: 'GitHub token' })
  await w.until(() => w.ack(ID2) !== undefined)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 more waiting/ })).toBeDefined()
  await ui.press({ key: 'decline' })
  await w.submission()
  expect(w.submitted[0]).toContain('CF_TOKEN')
  expect((await ui.find({ type: 'Text', text: /GH_TOKEN/ }))?.text).toBe('(GH_TOKEN)')
  await ui.unmount()
})

test('the scrubber replaces a saved value in any row before it is stored, including after a restart', async ($, on) => {
  const { tools } = world(on, { files: { 'CF_TOKEN.0123456789abcdef': { text: VALUE } } })
  const session = mock.session(on)
  await started($, tools)

  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `the token is ${VALUE}` }] } } as never)
  await $.session.append({
    message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `TOKEN=${VALUE}` }] },
  } as never)

  const rows = JSON.stringify(session.appended())
  expect(rows).not.toContain(VALUE)
  expect(rows).toContain('[secret:CF_TOKEN]')
})

test('a file past its day is deleted at session start and its value is no longer scrubbed', async ($, on) => {
  const old = 'old-token-0123456789'
  const { tools, processes, files } = world(on, {
    now: 90_000_000,
    files: { 'OLD.0123456789abcdef': { text: old, mtimeMs: 0 }, 'NEW.fedcba9876543210': { text: VALUE, mtimeMs: 89_000_000 } },
  })
  const session = mock.session(on)
  await started($, tools)

  expect(processes.filter((run) => run.argv[0] === 'rm').map((run) => run.argv.at(-1))).toEqual([`${DIR}/OLD.0123456789abcdef`])
  expect([...files.keys()]).toEqual([`${DIR}/NEW.fedcba9876543210`])
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `${old} ${VALUE}` }] } } as never)
  expect(JSON.stringify(session.appended())).toContain(`${old} [secret:NEW]`)
})

test('session start removes the queues of sessions untouched for an hour, and keeps its own and fresh ones', async ($, on) => {
  const hour = 60 * 60 * 1000
  const now = 10 * hour
  const w = world(on, { now, dirs: { '.requests/111': now - 2 * hour, '.requests/222': now - 60_000, '.requests/4242': now - 2 * hour, '.requests/x': 0 } })

  await started($, w.tools)

  const removed = w.processes.filter((run) => run.argv[0] === 'rm' && run.argv.includes('-rf')).map((run) => run.argv.at(-1))
  expect(removed).toEqual([`${DIR}/.requests/111`])
  expect([...w.dirs.keys()].sort()).toEqual([`${DIR}/.requests/222`, `${DIR}/.requests/4242`, `${DIR}/.requests/x`])
})
