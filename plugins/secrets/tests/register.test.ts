import { expect, mock, test } from 'claude-code/testing'
import { DIR, HOME, id, started, world } from './host'

const REQUEST = id('request_secret')
const VALUE = 'cf-token-0123456789'
const PANE = {
  plugin: 'secrets',
  component: 'Pane',
  requestId: 'secrets',
  props: { title: 'secrets', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const ASK = { tool: REQUEST, name: 'CF_TOKEN', label: 'Cloudflare token', reason: 'Wrangler deploys the worker', steps: ['Open the dashboard'] } as never

test('session start registers the request_secret tool and the /secrets command', async ($, on) => {
  const { tools, commands } = world(on)

  expect(await started($, tools)).toEqual(['request_secret'])
  expect(commands).toEqual(['secrets'])
})

test('the tool says it never returns the value and what to do with the file', async ($, on) => {
  const { tools } = world(on)
  await started($, tools)

  const description = tools[0]?.description ?? ''
  expect(description).toContain('You never see the value')
  expect(description).toContain('$(cat <file>)')
  expect(description).toContain('do not ask in chat')
})

test('a request opens the pane and answers at once, without waiting for the user', async ($, on) => {
  const { tools, opened, toasts, submitted } = world(on)
  await started($, tools)

  const answer = await $.tool.call(ASK)

  expect(opened).toEqual(['secrets'])
  expect(answer.result).toContain('Asked the user for CF_TOKEN in the secrets pane')
  expect(answer.result).toContain('Do not ask for it in chat')
  expect(toasts).toEqual(['Claude needs CF_TOKEN'])
  expect(submitted).toEqual([])
})

test('a terminal too narrow for the pane shows the card above the prompt and says so', async ($, on) => {
  const { tools, toasts } = world(on, { isPlaced: false })
  await started($, tools)

  const answer = await $.tool.call(ASK)

  expect(answer.result).toContain('too narrow')
  expect(answer.result).toContain('/secrets')
  expect(toasts).toEqual(['Claude needs CF_TOKEN: paste it above the prompt'])
})

test('a bad name or a missing label is an error result and opens nothing', async ($, on) => {
  const { tools, opened } = world(on)
  await started($, tools)

  const bad = await $.tool.call({ tool: REQUEST, name: '../x', label: 'x' } as never)
  const missing = await $.tool.call({ tool: REQUEST, name: 'OK' } as never)

  expect(bad).toMatchObject({ isError: true })
  expect(missing).toMatchObject({ isError: true })
  expect(opened).toEqual([])
})

test('the value pasted in the card goes to a private file on stdin and Claude is sent its path', async ($, on) => {
  const { tools, processes, submitted, files, submission } = world(on)
  await started($, tools)

  // one round on each surface, each with its own request
  for (const [round, surface] of (['terminal', 'desktop'] as const).entries()) {
    const name = `CF_TOKEN_${round}`
    await $.tool.call({ ...(ASK as object), name } as never)
    submitted.length = 0

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Claude needs a secret/ }))?.text).toBe('Claude needs a secret')
    await ui.input({ key: 'secret', text: `  ${VALUE}  ` })
    await submission()

    const write = processes.filter((run) => run.argv[0] === 'sh').at(-1)
    expect(write?.stdin).toBe(VALUE)
    // the value is on stdin only: nowhere in the command line, nor in what Claude is sent
    expect(write?.argv.join(' ')).not.toContain(VALUE)
    const file = write?.argv.at(-1) ?? ''
    expect(file).toMatch(new RegExp(`^${DIR}/${name}\\.[0-9a-f]{16}$`))
    expect(files.get(file)?.text).toBe(VALUE)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toContain(`"$(cat ${file})"`)
    expect(submitted[0]).not.toContain(VALUE)

    // the request is answered: the pane is idle again
    expect(await ui.find({ type: 'Text', text: /No secret is being asked for/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty paste saves nothing and keeps the card', async ($, on) => {
  const { tools, processes, submitted } = world(on)
  await started($, tools)
  await $.tool.call(ASK)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'secret', text: '   ' })

  expect(processes.filter((run) => run.argv[0] === 'sh')).toEqual([])
  expect(submitted).toEqual([])
  expect(await ui.find({ type: 'Text', text: /Claude needs a secret/ })).toBeDefined()
  await ui.unmount()
})

test('declining tells Claude not to ask in chat or retry, and stores nothing', async ($, on) => {
  const { tools, processes, submitted, submission } = world(on)
  await started($, tools)
  await $.tool.call(ASK)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'decline' })
  await submission()

  expect(submitted[0]).toContain('declined to provide CF_TOKEN')
  expect(submitted[0]).toContain('do not retry')
  expect(processes.filter((run) => run.argv[0] === 'sh')).toEqual([])
  await ui.unmount()
})

test('a write that fails tells Claude nothing was stored', async ($, on) => {
  const { tools, submitted, files, submission } = world(on, { writeExit: 1 })
  await started($, tools)
  await $.tool.call(ASK)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'secret', text: VALUE })
  await submission()

  expect(submitted[0]).toContain('Nothing was stored')
  expect(submitted[0]).not.toContain(VALUE)
  expect(files.size).toBe(0)
  await ui.unmount()
})

test('requests wait in line, one card at a time, in the order asked', async ($, on) => {
  const { tools, submission, submitted } = world(on)
  await started($, tools)
  await $.tool.call(ASK)
  await $.tool.call({ tool: REQUEST, name: 'GH_TOKEN', label: 'GitHub token' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 more waiting/ })).toBeDefined()
  await ui.press({ key: 'decline' })
  await submission()
  expect(submitted[0]).toContain('CF_TOKEN')
  expect((await ui.find({ type: 'Text', text: /GH_TOKEN/ }))?.text).toBe('(GH_TOKEN)')
  await ui.unmount()
})

test('the fence refuses the model\'s own tools in the folder and allows a file used inside a command', async ($, on) => {
  const { tools } = world(on)
  on('tool.call', () => ({ result: {} }))
  await started($, tools)
  const file = `${DIR}/CF_TOKEN.0123456789abcdef`

  expect(await $.tool.call({ tool: 'Read', file_path: file })).toMatchObject({ deny: expect.stringContaining('secrets folder is private') })
  expect(await $.tool.call({ tool: 'Bash', command: `cat ${file}` })).toMatchObject({ deny: expect.stringContaining('it touches the secrets folder') })
  expect(await $.tool.call({ tool: 'Grep', pattern: 'x', path: `${HOME}/.claude` } as never)).toMatchObject({ deny: expect.any(String) })

  // a build with no Grep or Glob tool searches through Bash
  expect(await $.tool.call({ tool: 'Bash', command: `grep -r token ${HOME}/.claude` })).toMatchObject({ deny: expect.stringContaining('holds the secrets folder') })
  expect(await $.tool.call({ tool: 'Bash', command: `TOKEN="$(cat ${file})" wrangler deploy` })).toEqual({ result: {} })
  expect(await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })).toEqual({ result: {} })
})

test('the scrubber replaces a saved value in any row before it is stored, including after a restart', async ($, on) => {
  const { tools } = world(on, { files: { 'CF_TOKEN.0123456789abcdef': { text: `${VALUE}\n`.trim() } } })
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
