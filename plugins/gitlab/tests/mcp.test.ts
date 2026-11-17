import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { folderOf, server, type CallContext } from '../server/mcp.ts'
import { SPECS } from '../server/tools.ts'
import { expect, test } from './expect.ts'

/** A server whose answers are kept in `out`, each call recorded with what it got. */
function session(opts: { reply?: (name: string) => Promise<{ text: string; isError?: true }> } = {}) {
  const out: Record<string, unknown>[] = []
  const calls: { name: string; input: Record<string, unknown>; context: CallContext }[] = []
  const mcp = server({
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    call: async (name, input, context) => {
      calls.push({ name, input, context })
      return opts.reply ? opts.reply(name) : { text: `ran ${name}` }
    },
    rootsTimeoutMs: 1_000,
  })
  const send = (message: Record<string, unknown>) => mcp.receive(JSON.stringify({ jsonrpc: '2.0', ...message }))
  return { out, calls, send }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

test('initialize answers the tools capability in the version asked, and tools/list lists the six tools with their schemas', async () => {
  const { out, send } = session()
  await send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })
  await send({ method: 'notifications/initialized' })
  await send({ id: 2, method: 'tools/list' })
  await send({ id: 3, method: 'ping' })

  expect(out[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'gitlab', version: '1' } } })
  const tools = (out[1]?.result as { tools: { name: string; inputSchema: unknown }[] }).tools
  expect(tools.map((t) => t.name)).toEqual(['gitlab_mr', 'gitlab_mr_comment', 'gitlab_pipeline', 'gitlab_job_log', 'gitlab_label', 'gitlab_user'])
  expect(tools[0]?.inputSchema).toEqual(SPECS[0]?.inputSchema)
  expect(out[2]).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  expect(out).toHaveLength(3)
})

test('a call answers its text as content, an error with isError, and an unknown tool or method is refused', async () => {
  const { out, calls, send } = session({ reply: async (name) => (name === 'gitlab_user' ? { text: 'nope', isError: true } : { text: 'ok' }) })
  await send({ id: 1, method: 'initialize', params: { capabilities: {} } })
  await send({ id: 2, method: 'tools/call', params: { name: 'gitlab_mr', arguments: { action: 'get', iid: 7 } } })
  await send({ id: 3, method: 'tools/call', params: { name: 'gitlab_user' } })
  await send({ id: 4, method: 'tools/call', params: { name: 'gitlab_api', arguments: {} } })
  await send({ id: 5, method: 'server/discover' })
  await settle()

  expect(calls.map((c) => [c.name, c.input])).toEqual([['gitlab_mr', { action: 'get', iid: 7 }], ['gitlab_user', {}]])
  const by = (id: number) => out.find((m) => m.id === id)
  expect(by(2)?.result).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  expect(by(3)?.result).toEqual({ content: [{ type: 'text', text: 'nope' }], isError: true })
  expect(by(4)?.error).toMatchObject({ code: -32602 })
  expect(by(5)?.error).toMatchObject({ code: -32601 })
})

test('a call that throws still answers, as an error that names no detail', async () => {
  const { out, send } = session({ reply: async () => { throw new Error('secret detail') } })
  await send({ id: 1, method: 'tools/call', params: { name: 'gitlab_mr', arguments: {} } })
  await settle()
  const result = out.find((m) => m.id === 1)?.result as { content: { text: string }[]; isError: true }
  expect(result.isError).toBe(true)
  expect(result.content[0]?.text).not.toContain('secret')
})

test("the session's folder comes from the client's roots, asked once and again after they change", async () => {
  const { out, calls, send } = session()
  await send({ id: 1, method: 'initialize', params: { capabilities: { roots: { listChanged: true } } } })
  const call = (id: number) => send({ id, method: 'tools/call', params: { name: 'gitlab_user', arguments: {}, _meta: { progressToken: id } } })
  const answerRoots = async (path: string) => {
    await settle()
    const asked = out.filter((m) => m.method === 'roots/list').at(-1)!
    await send({ id: asked.id, result: { roots: [{ uri: `file://${path}` }] } })
    await settle()
  }

  void call(2)
  await answerRoots('/work/app')
  void call(3)
  await settle()
  await send({ method: 'notifications/roots/list_changed' })
  void call(4)
  await answerRoots('/work/app%20two')

  expect(calls.map((c) => c.context.cwd)).toEqual(['/work/app', '/work/app', '/work/app two'])
  expect(out.filter((m) => m.method === 'roots/list')).toHaveLength(2)
})

test('without roots a call goes on with no folder, and a wait beats progress on the call token', async () => {
  const out: Record<string, unknown>[] = []
  const contexts: (string | undefined)[] = []
  const mcp = server({
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    call: async (_name, _input, context) => {
      contexts.push(context.cwd)
      context.progress('waiting')
      context.progress('waiting')
      return { text: 'done' }
    },
  })
  await mcp.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }))
  await mcp.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'gitlab_pipeline', arguments: {}, _meta: { progressToken: 'p' } } }))
  await settle()

  expect(contexts).toEqual([undefined])
  expect(out.filter((m) => m.method === 'notifications/progress').map((m) => m.params)).toEqual([
    { progressToken: 'p', progress: 1, message: 'waiting' },
    { progressToken: 'p', progress: 2, message: 'waiting' },
  ])
})

test('folderOf reads the first file root and nothing else', () => {
  expect(folderOf({ roots: [{ uri: 'file:///a/b%20c' }, { uri: 'file:///d' }] })).toBe('/a/b c')
  for (const bad of [undefined, {}, { roots: [] }, { roots: [{ uri: 'https://x' }] }, { roots: [{}] }]) expect(folderOf(bad)).toBeUndefined()
})

test('node runs server/main.ts as Claude Code starts it, and it lists the tools', async () => {
  const main = fileURLToPath(new URL('../server/main.ts', import.meta.url))
  // No token reaches the child: the test never calls a tool, and nothing goes to a network.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.includes('GITLAB')))
  const child = spawn(process.execPath, [main], { env: { ...env, SPIDER_GITLAB_OPTION_TOKENS: '' }, stdio: ['pipe', 'pipe', 'inherit'] })
  const lines: string[] = []
  const listed = new Promise<void>((resolve) => {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      lines.push(...chunk.split('\n').filter(Boolean))
      if (lines.length >= 2) resolve()
    })
  })
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)
  await listed
  child.kill()

  const tools = (JSON.parse(lines[1]!) as { result: { tools: { name: string }[] } }).result.tools
  expect(tools).toHaveLength(6)
})
