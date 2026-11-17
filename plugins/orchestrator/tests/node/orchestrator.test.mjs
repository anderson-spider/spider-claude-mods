// The orchestrator with a scripted turn and the real store in a temporary folder.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { MAX_WAIT_MS, RUNNING_TASK_NEXT, createOrchestrator, promptOf } from '../../daemon/orchestrator.mjs'
import { createStore } from '../../daemon/store.mjs'
import { inboxDirOf } from '../../hooks/paths.ts'

/** @import { TurnInput, TurnResult } from '../../daemon/acp.mjs' */

/** @type {string} */
let root
before(async () => (root = await mkdtemp(join(tmpdir(), 'orch-core-'))))
after(() => rm(root, { recursive: true, force: true }))

const SETTINGS = { maxRuntimeMode: /** @type {const} */ ('auto-accept-edits'), taskMinutes: 30 }
const caller = (sessionId = 'sess-1') => ({ sessionId, cwd: '/proj', settings: SETTINGS })
let worlds = 0

/**
 * An orchestrator whose turns are released by the test: each started turn waits until `finish` resolves it.
 * @param {{ ownerAlive?: boolean }} [opts]
 */
async function world(opts = {}) {
  const stateDir = join(root, `w${++worlds}`)
  const store = createStore(stateDir)
  await store.init()
  /** @type {{ input: TurnInput, resolve: (result: TurnResult) => void }[]} */
  const turns = []
  let ids = 0
  const orchestrator = createOrchestrator({
    store,
    runTurn: (input) => new Promise((resolve) => {
      turns.push({ input, resolve })
      input.onUpdate?.({ sessionId: 'agent-session', executedModel: 'gemini-4-argon-medium' })
      input.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', summary: '', executedModel: 'gemini-4-argon-medium', refused: [] }))
    }),
    probe: async () => ({ models: [{ id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon' }], currentModel: 'gemini-4-argon-medium', efforts: ['low', 'medium', 'high'] }),
    locate: async () => '/bin/agy',
    argvOf: (agy) => [agy, 'acp'],
    prepare: async () => undefined,
    probeDir: stateDir,
    version: '0.1.0',
    pid: 100,
    isAlive: () => opts.ownerAlive ?? false,
    newId: () => `task_test${String(++ids).padStart(4, '0')}`,
  })
  const started = async (count = 1) => {
    for (let i = 0; i < 100 && turns.length < count; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  /** @param {number} index @param {Partial<TurnResult>} result */
  const finish = async (index, result) => {
    turns[index]?.resolve({ status: 'completed', summary: 'All good.', executedModel: 'gemini-4-argon-medium', refused: [], ...result })
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const inbox = async (sessionId = 'sess-1') => {
    const dir = inboxDirOf(stateDir, sessionId)
    const names = await readdir(dir).catch(() => [])
    return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))))
  }
  return { orchestrator, store, turns, started, finish, inbox, stateDir }
}

test('an async delegation returns at once with next; its end leaves the parent one notice with the result', async () => {
  const w = await world()
  const result = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Review the parser\nin src/parse.ts', role: 'review', effort: 'high' }))
  assert.equal(result.taskId, 'task_test0001')
  assert.equal(result.title, 'Review the parser')
  assert.equal(result.workState, 'working')
  assert.equal(result.runtimeMode, 'auto-accept-edits')
  assert.equal(result.next, RUNNING_TASK_NEXT)
  await w.started()
  const input = /** @type {TurnInput} */ (w.turns[0]?.input)
  assert.equal(input.cwd, '/proj')
  assert.equal(input.effort, 'high')
  assert.equal(input.runtimeMode, 'auto-accept-edits')
  assert.equal(input.deadlineMs, 30 * 60_000)
  assert.deepEqual(input.argv, ['/bin/agy', 'acp'])
  assert.match(input.prompt, /^Review the parser\nin src\/parse\.ts\n\n---\nYou are a delegated review subagent working in \/proj\. You may edit files inside \/proj; edits elsewhere and commands are refused\./)

  const running = /** @type {any} */ (await w.orchestrator.status(caller(), { taskId: 'task_test0001' }))
  assert.equal(running.status, 'running')
  await w.finish(0, { summary: 'One bug at line 3.', refused: [{ kind: 'execute', title: 'npm test', reason: 'needs approval in auto-accept-edits' }] })
  const notices = await w.inbox()
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /^Delegated task task_test0001 \("Review the parser"\) on agy \(gemini-4-argon-medium\) completed\. Its result:\n\nOne bug at line 3\.\n\nRefused actions \(auto-accept-edits\): npm test \(needs approval in auto-accept-edits\)$/)

  // Reading the result first takes the notice back.
  const ended = /** @type {any} */ (await w.orchestrator.status(caller(), { taskId: 'task_test0001' }))
  assert.equal(ended.workState, 'result_available')
  assert.equal(ended.summary, 'One bug at line 3.')
  assert.deepEqual(await w.inbox(), [])
})

test('a wait returns the result and sends no notice; one past its timeout leaves the task running, with next', async () => {
  const w = await world()
  const waited = w.orchestrator.delegate(caller(), { task: 'Quick', mode: 'wait' })
  await w.started()
  await w.finish(0, { summary: 'Done quickly.' })
  const result = /** @type {any} */ (await waited)
  assert.equal(result.status, 'completed')
  assert.equal(result.waitTimedOut, false)
  assert.equal(result.next, undefined)
  assert.deepEqual(await w.inbox(), [])

  const timedOut = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Slow', mode: 'wait', timeoutMs: 50 }))
  assert.equal(timedOut.waitTimedOut, true)
  assert.equal(timedOut.next, RUNNING_TASK_NEXT)
  assert.ok(MAX_WAIT_MS === 45_000)
})

test('a retry with the same clientRequestId returns the same task; another round with a new id starts another', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Round 1', clientRequestId: 'review-r1' }))
  const again = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Round 1', clientRequestId: 'review-r1' }))
  const other = /** @type {any} */ (await w.orchestrator.delegate(caller('sess-2'), { task: 'Round 1', clientRequestId: 'review-r1' }))
  assert.equal(again.taskId, first.taskId)
  assert.notEqual(other.taskId, first.taskId)
  await w.started(2)
  assert.equal(w.turns.length, 2)
})

test('inputs are checked before anything runs: escalation, worktree, another provider, bad effort, role and mode', async () => {
  const w = await world()
  /** @param {Record<string, unknown>} input */
  const code = async (input) => /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x', ...input })).error?.code
  assert.equal(await code({ runtimeMode: 'full-access' }), 'runtime_mode_escalation_denied')
  assert.equal(await code({ isolation: 'worktree' }), 'isolation_unavailable')
  assert.equal(await code({ providerInstanceId: 'codex' }), 'provider_unavailable')
  assert.equal(await code({ effort: 'max' }), 'invalid_input')
  assert.equal(await code({ role: 'boss' }), 'invalid_input')
  assert.equal(await code({ mode: 'later' }), 'invalid_input')
  assert.equal(await code({ model: 'bad model!' }), 'invalid_input')
  assert.equal(/** @type {any} */ (await w.orchestrator.delegate(caller(), { task: '  ' })).error.code, 'invalid_input')
  assert.equal(w.turns.length, 0)
  const narrower = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Read only', runtimeMode: 'approval-required' }))
  assert.equal(narrower.runtimeMode, 'approval-required')
  await w.started()
  assert.match(w.turns[0]?.input.prompt ?? '', /Read only: do not edit files or run commands/)
})

test("another session's task is not found; a cancel stops a running task and its end sends no notice", async () => {
  const w = await world()
  const { taskId } = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Long one' }))
  assert.equal(/** @type {any} */ (await w.orchestrator.status(caller('sess-2'), { taskId })).error.code, 'task_not_found')
  assert.equal(/** @type {any} */ (await w.orchestrator.cancel(caller('sess-2'), { taskId })).error.code, 'task_not_found')
  await w.started()
  assert.deepEqual(await w.orchestrator.cancel(caller(), { taskId, reason: 'replaced' }), { taskId, status: 'cancel_requested' })
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  const ended = /** @type {any} */ (await w.orchestrator.status(caller(), { taskId }))
  assert.equal(ended.status, 'cancelled')
  assert.equal(ended.error, 'Cancelled: replaced')
  assert.deepEqual(await w.inbox(), [])
  assert.deepEqual(await w.orchestrator.cancel(caller(), { taskId }), { taskId, status: 'cancelled' })
})

test('on start, a task left running by a daemon that is gone ends as interrupted with a notice; a live daemon keeps its own', async () => {
  const w = await world()
  const base = { parentSessionId: 'sess-1', title: 't', role: 'general', task: 't', cwd: '/proj', providerInstanceId: 'agy', model: null, options: {}, runtimeMode: 'auto-accept-edits', isolation: 'shared', createdAt: 1, summary: null, executedModel: null, refused: [], delivered: false }
  await w.store.save(/** @type {any} */ ({ ...base, taskId: 'task_gone0001', status: 'running', ownerPid: 99 }))
  await w.orchestrator.recover()
  assert.equal((await w.store.load('task_gone0001'))?.status, 'interrupted')
  assert.match((await w.inbox())[0].text, /task_gone0001 \("t"\) on agy interrupted: The orchestrator stopped before the task ended\./)

  const live = await world({ ownerAlive: true })
  await live.store.save(/** @type {any} */ ({ ...base, taskId: 'task_live0001', status: 'running', ownerPid: 99 }))
  await live.orchestrator.recover()
  assert.equal((await live.store.load('task_live0001'))?.status, 'running')
  assert.equal(/** @type {any} */ (await live.orchestrator.cancel(caller(), { taskId: 'task_live0001' })).error.code, 'task_not_cancellable')
})

test('capabilities list agy with its models and efforts, and the runtime modes up to the ceiling', async () => {
  const w = await world()
  const found = /** @type {any} */ (await w.orchestrator.capabilities(caller()))
  assert.deepEqual(found.providers[0], {
    providerInstanceId: 'agy',
    driverKind: 'antigravity',
    name: 'Antigravity CLI (agy)',
    available: true,
    models: [{ id: 'gemini-4-argon-medium', name: 'Gemini 4 Argon' }],
    defaultModel: 'gemini-4-argon-medium',
    options: [{ id: 'effort', values: ['low', 'medium', 'high'] }],
  })
  assert.deepEqual(found.runtimeModes, ['approval-required', 'auto-accept-edits'])
  assert.equal(found.defaultRuntimeMode, 'auto-accept-edits')
})

test('a provider that is not ready fails the task with why, and the parent hears of it', async () => {
  const stateDir = join(root, 'not-ready')
  const store = createStore(stateDir)
  await store.init()
  const orchestrator = createOrchestrator({
    store,
    runTurn: async () => assert.fail('no turn'),
    probe: async () => ({ error: 'x' }),
    locate: async () => '/bin/agy',
    argvOf: (agy) => [agy],
    prepare: async () => "agy's orchestrator profile sets hooks",
    probeDir: stateDir,
    version: '0',
    pid: 1,
    isAlive: () => false,
  })
  const result = /** @type {any} */ (await orchestrator.delegate(caller(), { task: 'x', mode: 'wait', timeoutMs: 2_000 }))
  assert.equal(result.status, 'failed')
  assert.equal(result.error, "agy's orchestrator profile sets hooks")
  assert.equal(promptOf({ ...result, task: 'x', role: 'general', cwd: '/p', runtimeMode: 'full-access' }).endsWith('You may edit files and run commands. You cannot ask questions: decide, and say what you assumed. End with your result.'), true)
})
