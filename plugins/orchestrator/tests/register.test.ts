import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { inboxDirOf, stateDirOf } from '../hooks/paths'

const INBOX = inboxDirOf(stateDirOf('/h'), 'sess-1')

/** The engine beneath the module: env, session id, an inbox folder in memory, rm, and the prompts it submits. */
function world(on: On, files: Record<string, string> = {}) {
  const texts = { ...files }
  const submitted: string[] = []
  const removed: string[] = []
  const registered: string[] = []
  const clock = mock.clock(on, { now: 1_000 })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => (registered.push(e.name), { value: { tool: e.name } }))
  on('command.register', (_$, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('fs.list', (_$, e) => {
    const names = Object.keys(texts).filter(path => path.startsWith(`${e.path}/`)).map(path => path.slice((e.path ?? '').length + 1))
    return names.length ? { value: names.map((name, i) => ({ name, kind: 'file' as const, size: 1, mtimeMs: i, isLink: false })) } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.read', (_$, e) => (e.path in texts ? { value: texts[e.path]! } : { deny: `ENOENT: ${e.path}` }))
  on('process.run', (_$, e) => {
    const [command, , , path = ''] = e.argv
    if (command !== 'rm') return { deny: `unexpected ${e.argv.join(' ')}` }
    removed.push(path)
    delete texts[path]
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.submit', (_$, e) => (submitted.push(e.text), { text: e.text }))
  return { texts, submitted, removed, registered, clock }
}

const start = ($: { session: { start: (e: never) => Promise<unknown> } }) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

test('session start registers no tool and no command: the MCP server serves the tools', async ($, on) => {
  const host = world(on)
  await start($)
  expect(host.registered).toEqual([])
})

test("a task's notice is submitted once as a prompt, its file removed first, and a broken one is dropped", async ($, on) => {
  const host = world(on, {
    [`${INBOX}/task_aaa111.json`]: JSON.stringify({ taskId: 'task_aaa111', text: 'Delegated task task_aaa111 ("Review") on agy completed. Its result:\n\nLooks fine.' }),
    [`${INBOX}/task_bbb222.json`]: '{ not json',
  })
  await start($)
  await host.clock.advance(2_000)
  await host.clock.advance(2_000)

  expect(host.submitted).toEqual(['Delegated task task_aaa111 ("Review") on agy completed. Its result:\n\nLooks fine.'])
  expect(host.removed.sort()).toEqual([`${INBOX}/task_aaa111.json`, `${INBOX}/task_bbb222.json`])
  await host.clock.advance(2_000)
  expect(host.submitted).toHaveLength(1)
})

test('the system prompt tells Claude when to delegate, to follow next instead of polling, and to brief the child in full', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'orchestrator:delegation'])
  const section = composed.sections.at(-1)?.text ?? ''
  expect(section).toMatch(/native Agent tool for a Claude subagent\. Use `mcp__plugin_orchestrator_orchestrator__delegate_task`/)
  expect(section).toMatch(/Do not poll it/)
  expect(section).toMatch(/The child does not see this conversation/)
})
