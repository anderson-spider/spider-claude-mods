// runTurn against the scripted agent (fake-agent.mjs) on real processes.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { RETRY_PROMPT, probe, runTurn } from '../../daemon/acp.mjs'

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))
/** @type {string} */
let dir
before(async () => (dir = await realpath(await mkdtemp(join(tmpdir(), 'orch-acp-')))))
after(() => rm(dir, { recursive: true, force: true }))

let runs = 0
/**
 * One turn on the fake agent; resolves its result and what the agent logged.
 * @param {object} script
 * @param {Partial<import('../../daemon/acp.mjs').TurnInput>} [extra]
 */
async function turn(script, extra = {}) {
  const logFile = join(dir, `agent-${++runs}.log`)
  const result = await runTurn({
    argv: [process.execPath, AGENT, 'acp', '--sandbox'],
    cwd: dir,
    env: { ...process.env, FAKE_AGENT_SCRIPT: JSON.stringify(script), FAKE_AGENT_LOG: logFile },
    prompt: 'Review it',
    runtimeMode: 'auto-accept-edits',
    deadlineMs: 20_000,
    ...extra,
  })
  const log = (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { result, log, got: log.filter((entry) => entry.got).map((entry) => entry.got) }
}

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('a turn starts a session in the folder, keeps the default mode, sets the model and effort, and returns the text', async () => {
  const updates = /** @type {any[]} */ ([])
  const { result, log, got } = await turn({ noise: true, steps: [{ tool: 'Read sum.ts' }, { say: 'Off by ' }, { say: 'one.' }] }, { model: 'gemini-3.8-flash-low', effort: 'high', onUpdate: (u) => updates.push(u) })
  assert.equal(result.status, 'completed')
  assert.equal(result.summary, 'Off by one.')
  assert.equal(result.sessionId, '11111111-2222-3333-4444-555555555555')
  assert.equal(result.executedModel, 'gemini-3.8-flash-low')
  assert.deepEqual(got.map((m) => m.method), ['initialize', 'session/new', 'session/set_mode', 'session/set_model', 'session/set_config_option', 'session/prompt'])
  assert.deepEqual(got[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false })
  assert.deepEqual(got[1].params, { cwd: dir, mcpServers: [] })
  assert.deepEqual(got[2].params, { sessionId: result.sessionId, modeId: 'default' })
  assert.deepEqual(got[4].params, { sessionId: result.sessionId, configId: 'thought_level', value: 'high' })
  assert.ok(updates.some((u) => u.progress === 'Read sum.ts'))
  const start = log.find((entry) => entry.start).start
  assert.equal(start.cwd, dir)
  assert.equal(alive(start.pid), false)
})

test('permission requests follow the runtime mode: an edit inside passes, one outside and a command are refused and listed', async () => {
  const { result, log } = await turn({
    steps: [
      { permission: { kind: 'edit', title: 'File a.ts', locations: [{ path: join(dir, 'a.ts') }] } },
      { permission: { kind: 'edit', title: 'File /etc/x', locations: [{ path: '/etc/x' }] } },
      { permission: { kind: 'execute', title: 'rm -rf /' } },
      { fs: true },
      { say: 'Edited a.ts; the rest was refused.' },
    ],
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(log.filter((e) => e.permission).map((e) => e.answer.outcome.optionId), ['allow', 'deny', 'deny'])
  assert.deepEqual(result.refused, [
    { kind: 'edit', title: 'File /etc/x', reason: 'outside the work folder' },
    { kind: 'execute', title: 'rm -rf /', reason: 'needs approval in auto-accept-edits' },
  ])
  assert.equal(log.find((e) => e.fs).fs.code, -32601)
})

test('a turn that ends empty after a refusal is prompted on, again after each new refusal, until it answers', async () => {
  const { result, got } = await turn(
    { steps: [{ permission: { kind: 'execute', title: 'npm test' } }], retrySteps: [[{ permission: { kind: 'edit', title: 'File /etc/x', locations: [{ path: '/etc/x' }] } }], [{ say: 'Could not run the tests; the code reads fine.' }]] },
    { runtimeMode: 'approval-required' },
  )
  assert.equal(result.status, 'completed')
  assert.equal(result.summary, 'Could not run the tests; the code reads fine.')
  const prompts = got.filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt[0].text)
  assert.deepEqual(prompts, ['Review it', RETRY_PROMPT, RETRY_PROMPT])
})

test('a turn that ends empty with no new refusal is not prompted again, and fails as empty', async () => {
  const { result, got } = await turn({ steps: [{ permission: { kind: 'execute', title: 'npm test' } }], retrySteps: [[]] }, { runtimeMode: 'approval-required' })
  assert.equal(result.status, 'failed')
  assert.equal(got.filter((m) => m.method === 'session/prompt').length, 2)
})

test('an abort cancels the turn through session/cancel; a deadline does too, as timed out', async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const cancelled = await turn({ steps: [{ say: 'Working' }, { sleep: 10_000 }] }, { signal: controller.signal })
  assert.equal(cancelled.result.status, 'cancelled')
  assert.ok(cancelled.got.some((m) => m.method === 'session/cancel'))

  const late = await turn({ steps: [{ sleep: 10_000 }] }, { deadlineMs: 300 })
  assert.equal(late.result.status, 'failed')
  assert.equal(late.result.errorKind, 'timed_out')
})

test('an unknown model, an agent that dies and an empty answer fail with the reason', async () => {
  const model = await turn({}, { model: 'nope' })
  assert.equal(model.result.status, 'failed')
  assert.equal(model.result.errorKind, 'model_unavailable')
  assert.match(model.result.error ?? '', /Unknown model ID: nope/)
  assert.equal(model.got.some((m) => m.method === 'session/prompt'), false)

  const died = await turn({ steps: [{ exit: 7 }] })
  assert.equal(died.result.status, 'failed')
  assert.match(died.result.error ?? '', /agy exited \(code 7\)/)

  const crashed = await turn({ crashAtStart: true })
  assert.equal(crashed.result.status, 'failed')

  const empty = await turn({ steps: [] })
  assert.equal(empty.result.status, 'failed')
  assert.match(empty.result.error ?? '', /without an answer/)
})

test('the probe reads the models and thinking levels and spends no prompt', async () => {
  const logFile = join(dir, 'probe.log')
  const found = await probe({ argv: [process.execPath, AGENT], cwd: dir, env: { ...process.env, FAKE_AGENT_LOG: logFile } })
  assert.deepEqual(found, {
    models: [{ id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon' }, { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash' }],
    currentModel: 'gemini-4-argon-medium',
    efforts: ['low', 'medium', 'high'],
  })
  assert.doesNotMatch(await readFile(logFile, 'utf8'), /session\/prompt/)
})

test('read-only refuses an edit and a command with the reason read-only, and lets a read pass', async () => {
  const { result, log } = await turn(
    { steps: [{ permission: { kind: 'read', title: 'Read a.ts' } }, { permission: { kind: 'edit', title: 'File a.ts', locations: [{ path: join(dir, 'a.ts') }] } }, { permission: { kind: 'execute', title: 'ls' } }, { say: 'Read it.' }] },
    { runtimeMode: 'read-only' },
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(log.filter((e) => e.permission).map((e) => e.answer.outcome.optionId), ['allow', 'deny', 'deny'])
  assert.deepEqual(result.refused, [
    { kind: 'edit', title: 'File a.ts', reason: 'read-only' },
    { kind: 'execute', title: 'ls', reason: 'read-only' },
  ])
})

test('a resumed turn goes on with the session through session/resume, and a failed resume says to send with freshContext', async () => {
  const resumed = await turn({ steps: [{ say: 'Still here.' }] }, { resumeSessionId: 'session-from-before', prompt: 'And the tests?' })
  assert.equal(resumed.result.status, 'completed')
  assert.equal(resumed.result.sessionId, 'session-from-before')
  assert.equal(resumed.result.summary, 'Still here.')
  assert.deepEqual(resumed.got.map((m) => m.method), ['initialize', 'session/resume', 'session/set_mode', 'session/prompt'])
  assert.deepEqual(resumed.got[1].params, { sessionId: 'session-from-before', cwd: dir, mcpServers: [] })
  assert.equal(resumed.got.at(-1).params.prompt[0].text, 'And the tests?')

  const lost = await turn({ resumeError: 'Session not found' }, { resumeSessionId: 'session-gone' })
  assert.equal(lost.result.status, 'failed')
  assert.equal(lost.result.errorKind, 'agent_error')
  assert.match(lost.result.error ?? '', /could not resume its session: Session not found.*freshContext/)
  assert.equal(lost.got.some((m) => m.method === 'session/new' || m.method === 'session/prompt'), false)
})
