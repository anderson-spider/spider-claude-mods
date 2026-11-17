// The MCP server as Claude Code runs it: a node process on stdio, with the plugin's options in its environment.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../../server/main.mjs', import.meta.url))

/** @type {string} */
let tmp

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agy-server-'))
})
after(() => rm(tmp, { recursive: true, force: true }))

/**
 * Starts the server and returns a call that sends one request and resolves with its answer.
 * @param {Record<string, string>} env
 */
function serve(env = {}) {
  const child = spawn(process.execPath, [MAIN], { env: { ...process.env, TMPDIR: tmp, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
  /** @type {Map<number, (message: any) => void>} */
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  let ids = 0
  return {
    /** @param {string} method @param {object} [params] */
    request: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++ids
        waiting.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }),
    stop: () => child.kill(),
  }
}

test('the server says hello, lists the four tools with their schemas, and answers the jobs tool from the job files', async () => {
  const server = serve()
  try {
    const hello = /** @type {any} */ (await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} }))
    assert.equal(hello.result.protocolVersion, '2025-06-18')
    assert.deepEqual(hello.result.capabilities, { tools: {} })

    const listed = /** @type {any} */ (await server.request('tools/list'))
    assert.deepEqual(listed.result.tools.map((/** @type {any} */ tool) => tool.name), ['ask', 'image', 'review', 'jobs'])
    assert.ok(listed.result.tools.every((/** @type {any} */ tool) => tool.description && tool.inputSchema.type === 'object'))

    const jobs = /** @type {any} */ (await server.request('tools/call', { name: 'jobs', arguments: {} }))
    assert.deepEqual(jobs.result, { content: [{ type: 'text', text: 'No agy jobs.' }] })

    const unknown = /** @type {any} */ (await server.request('tools/call', { name: 'nope', arguments: {} }))
    assert.equal(unknown.error.code, -32602)
  } finally {
    server.stop()
  }
})

test('an option from the environment applies: an agyPath that is not there makes an ask an error naming it, and starts nothing', async () => {
  const server = serve({ SPIDER_ANTIGRAVITY_OPTION_AGY_PATH: join(tmp, 'missing-agy') })
  try {
    await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    const asked = /** @type {any} */ (await server.request('tools/call', { name: 'ask', arguments: { prompt: 'Hi' } }))
    assert.equal(asked.result.isError, true)
    assert.match(asked.result.content[0].text, /agyPath/)
  } finally {
    server.stop()
  }
})
