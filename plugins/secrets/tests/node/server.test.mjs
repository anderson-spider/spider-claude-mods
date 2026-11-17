// The MCP server and request_secret, on Node (node --test; `claude plugin test` runs only *.test.ts).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ask } from '../../server/ask.mjs'
import { server } from '../../server/mcp.mjs'
import { REQUEST_SECRET } from '../../server/tool.mjs'

/** @import { AskDeps } from '../../server/ask.mjs' */

const HOME = '/home/me'
const QUEUE = `${HOME}/.claude/secrets/.requests/4242`
const ID = '0123456789abcdef'
const ASK = { name: 'CF_TOKEN', label: 'Cloudflare token', steps: ['Open the dashboard'] }

/**
 * Files in memory, a clock that moves only when the server sleeps, and a module that answers when `answer` says.
 * @param {(files: Map<string, string>) => void} [answer]
 */
function host(answer = () => {}) {
  /** @type {Map<string, string>} */
  const files = new Map()
  /** @type {string[]} */
  const written = []
  let now = 0
  /** @type {AskDeps} */
  const deps = {
    env: { home: HOME },
    pid: 4242,
    async write(dir, file, text) {
      written.push(`${dir}/${file}`)
      files.set(`${dir}/${file}`, text)
    },
    read: async (path) => files.get(path),
    remove: async (path) => files.delete(path),
    sleep: async (ms) => {
      now += ms
      answer(files)
    },
    now: () => now,
    random: () => ID,
  }
  return { deps, files, written, now: () => now }
}

/** The module, as the server sees it: takes the request and answers where the card is. */
const module = (/** @type {string} */ placement) => (/** @type {Map<string, string>} */ files) => {
  if (files.delete(`${QUEUE}/${ID}.json`)) files.set(`${QUEUE}/${ID}.ack`, placement)
}

test("a request is queued in the Claude Code process's folder and answered once the module says the card is in the pane", async () => {
  const { deps, files, written } = host(module('pane'))

  const reply = await ask(deps, ASK)

  assert.deepEqual(written, [`${QUEUE}/${ID}.json`])
  assert.match(reply.text, /Asked the user for CF_TOKEN in the secrets pane/)
  assert.equal(reply.isError, undefined)
  assert.equal(files.size, 0)
})

test('a card above the prompt is said to be there, for Claude to tell the user', async () => {
  const { deps } = host(module('band'))

  const reply = await ask(deps, ASK)

  assert.match(reply.text, /too narrow/)
  assert.equal(reply.isError, undefined)
})

test('a request no module takes is withdrawn after five seconds, and Claude is told no card could be shown', async () => {
  const { deps, files, now } = host()

  const reply = await ask(deps, ASK)

  assert.equal(now(), 5_000)
  assert.equal(reply.isError, true)
  assert.match(reply.text, /No secrets card could be shown/)
  assert.equal(files.size, 0)
})

test('a request taken without an answer in time is on screen, so Claude is told to wait', async () => {
  const { deps } = host((files) => void files.delete(`${QUEUE}/${ID}.json`))

  const reply = await ask(deps, ASK)

  assert.equal(reply.isError, undefined)
  assert.match(reply.text, /Stop here and wait/)
})

test('a bad request or no home folder is an error and queues nothing', async () => {
  const bad = host()
  assert.equal((await ask(bad.deps, { name: '../x', label: 'x' })).isError, true)
  assert.deepEqual(bad.written, [])

  const homeless = host()
  homeless.deps.env = {}
  const reply = await ask(homeless.deps, ASK)
  assert.equal(reply.isError, true)
  assert.match(reply.text, /No home folder/)
  assert.deepEqual(homeless.written, [])
})

test('the tool tells Claude it never sees the value and what to do with the file', () => {
  assert.match(REQUEST_SECRET.description, /You never see the value/)
  assert.ok(REQUEST_SECRET.description.includes('$(cat <file>)'))
  assert.match(REQUEST_SECRET.description, /do not ask in chat/)
})

test('the server lists request_secret, answers a call as text content, and refuses an unknown tool or method', async () => {
  /** @type {Record<string, unknown>[]} */
  const out = []
  const mcp = server({
    tools: [REQUEST_SECRET],
    write: (line) => out.push(JSON.parse(line)),
    call: async () => ({ text: 'asked' }),
  })
  const send = (/** @type {Record<string, unknown>} */ message) => mcp.receive(JSON.stringify({ jsonrpc: '2.0', ...message }))

  await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
  await send({ method: 'notifications/initialized' })
  await send({ id: 2, method: 'tools/list' })
  await send({ id: 3, method: 'tools/call', params: { name: 'request_secret', arguments: ASK } })
  await send({ id: 4, method: 'tools/call', params: { name: 'other' } })
  await send({ id: 5, method: 'resources/list' })
  await new Promise((resolve) => setTimeout(resolve, 10))

  const byId = (/** @type {number} */ id) => out.find((message) => message.id === id)
  assert.deepEqual(byId(1), { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'secrets', version: '1' } } })
  assert.deepEqual(byId(2), { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'request_secret', description: REQUEST_SECRET.description, inputSchema: REQUEST_SECRET.inputSchema }] } })
  assert.deepEqual(byId(3), { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'asked' }] } })
  assert.equal(/** @type {{ error: { code: number } }} */ (byId(4)).error.code, -32602)
  assert.equal(/** @type {{ error: { code: number } }} */ (byId(5)).error.code, -32601)
  assert.equal(out.length, 5)
})

test('node starts the server from main.mjs and it lists the tool', async () => {
  const main = fileURLToPath(new URL('../../server/main.mjs', import.meta.url))
  const child = spawn(process.execPath, [main], { stdio: ['pipe', 'pipe', 'inherit'] })
  /** @type {string[]} */
  const lines = []
  child.stdout.setEncoding('utf8').on('data', (/** @type {string} */ chunk) => lines.push(...chunk.split('\n').filter(Boolean)))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`)
  for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  child.kill()

  const tools = JSON.parse(lines[0] ?? '{}').result?.tools ?? []
  assert.deepEqual(tools.map((/** @type {{ name: string }} */ tool) => tool.name), ['request_secret'])
})
