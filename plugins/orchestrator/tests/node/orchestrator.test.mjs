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
 * Each new agent session is `agent-session-<turn>`; a resumed one keeps its id. lateSession: the session id arrives
 * only when the turn ends.
 * @param {{ ownerAlive?: boolean, lateSession?: boolean }} [opts]
 */
async function world(opts = {}) {
  const stateDir = join(root, `w${++worlds}`)
  const store = createStore(stateDir)
  await store.init()
  /** @type {{ input: TurnInput, resolve: (result: TurnResult) => void }[]} */
  const turns = []
  /** @type {string[]} */
  const sessions = []
  let ids = 0
  const orchestrator = createOrchestrator({
    store,
    runTurn: (input) => new Promise((resolve) => {
      turns.push({ input, resolve })
      const sessionId = input.resumeSessionId ?? `agent-session-${turns.length}`
      sessions.push(sessionId)
      if (!opts.lateSession) input.onUpdate?.({ sessionId, executedModel: 'gemini-4-argon-medium' })
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
    if (opts.lateSession) turns[index]?.input.onUpdate?.({ sessionId: sessions[index] })
    turns[index]?.resolve({ status: 'completed', summary: 'All good.', executedModel: 'gemini-4-argon-medium', refused: [], sessionId: sessions[index], ...result })
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
  assert.equal(result.threadId, 'thread_test0001')
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
  assert.match(notices[0].text, /^Delegated task task_test0001 \(thread thread_test0001\) \("Review the parser"\) on agy \(gemini-4-argon-medium\) completed\. Its result:\n\nOne bug at line 3\.\n\nRefused actions \(auto-accept-edits\): npm test \(needs approval in auto-accept-edits\)$/)

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
  assert.deepEqual(found.runtimeModes, ['read-only', 'approval-required', 'auto-accept-edits'])
  assert.equal(found.defaultRuntimeMode, 'auto-accept-edits')
  assert.deepEqual(found.threadSendModes, ['auto', 'queue', 'restart'])
  const narrow = /** @type {any} */ (await w.orchestrator.capabilities({ ...caller(), settings: { ...SETTINGS, maxRuntimeMode: 'read-only' } }))
  assert.deepEqual(narrow.runtimeModes, ['read-only'])
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

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5)) }
/** @param {string} sessionId @param {import('../../daemon/policy.mjs').RuntimeMode} maxRuntimeMode */
const narrowed = (sessionId, maxRuntimeMode) => ({ ...caller(sessionId), settings: { ...SETTINGS, maxRuntimeMode } })

test('a read-only delegation tells the child it reads only', async () => {
  const w = await world()
  const result = /** @type {any} */ (await w.orchestrator.delegate(narrowed('sess-1', 'read-only'), { task: 'Look' }))
  assert.equal(result.runtimeMode, 'read-only')
  await w.started()
  assert.equal(w.turns[0]?.input.runtimeMode, 'read-only')
  assert.match(w.turns[0]?.input.prompt ?? '', /Read only: do not edit files or run commands/)
})

test('thread_send on an ended thread resumes its agent session with the message alone; the first result stays', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Review the parser', title: 'Review' }))
  await w.started()
  await w.finish(0, { summary: 'One bug.' })
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'Is the bug in the tests too?' }))
  assert.equal(sent.taskId, 'task_test0002')
  assert.equal(sent.threadId, first.threadId)
  assert.equal(sent.delivery, 'started')
  assert.equal(sent.title, 'Is the bug in the tests too?')
  assert.equal(sent.runtimeMode, 'auto-accept-edits')
  assert.equal(sent.next, RUNNING_TASK_NEXT)
  await w.started(2)
  assert.equal(w.turns[1]?.input.resumeSessionId, 'agent-session-1')
  assert.equal(w.turns[1]?.input.prompt, 'Is the bug in the tests too?')
  assert.equal(w.turns[1]?.input.cwd, '/proj')
  await w.finish(1, { summary: 'No.' })
  const earlier = /** @type {any} */ (await w.orchestrator.status(caller(), { taskId: first.taskId }))
  assert.equal(earlier.summary, 'One bug.')
  assert.equal(earlier.status, 'completed')
  const later = /** @type {any} */ (await w.orchestrator.status(caller(), { taskId: sent.taskId }))
  assert.equal(later.summary, 'No.')
  assert.equal(later.threadId, first.threadId)
  assert.equal((await w.store.loadThread(first.threadId))?.agentSessionId, 'agent-session-1')
})

test('thread_send while a task runs queues the follow-up, which resumes the session once the first one ends', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Step one' }))
  await w.started()
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'Then step two', mode: 'queue' }))
  assert.equal(sent.delivery, 'queued')
  assert.equal(sent.status, 'queued')
  assert.equal(sent.workState, 'queued')
  assert.equal(w.orchestrator.busy(), 2)
  await settle()
  assert.equal(w.turns.length, 1)
  await w.finish(0, { summary: 'Step one done.' })
  await w.started(2)
  assert.equal(w.turns[1]?.input.resumeSessionId, 'agent-session-1')
  assert.equal(w.turns[1]?.input.prompt, 'Then step two')
  assert.equal((await w.store.load(sent.taskId))?.status, 'running')
})

test('a follow-up queued before the first turn has an agent session still resumes the one it opens', async () => {
  const w = await world({ lateSession: true })
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Step one' }))
  await w.started()
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'Then step two' }))
  assert.equal(sent.delivery, 'queued')
  await w.finish(0, {})
  await w.started(2)
  assert.equal(w.turns[1]?.input.resumeSessionId, 'agent-session-1')
  assert.equal(w.turns[1]?.input.prompt, 'Then step two')
})

test('restart interrupts the running task with no notice and runs the new one on the same session', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'Wrong direction' }))
  await w.started()
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'Stop; do this instead', mode: 'restart' }))
  assert.equal(sent.delivery, 'restarted')
  await w.started(2)
  const replaced = /** @type {any} */ (await w.orchestrator.status(caller(), { taskId: first.taskId }))
  assert.equal(replaced.status, 'interrupted')
  assert.equal(replaced.error, 'Replaced by a thread_send restart.')
  assert.equal(w.turns[1]?.input.resumeSessionId, 'agent-session-1')
  await w.finish(1, { summary: 'Done instead.' })
  const notices = await w.inbox()
  assert.deepEqual(notices.map((notice) => notice.taskId), [sent.taskId])
})

test('freshContext starts a new agent session with the full brief, which later follow-ups resume', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'First brief', role: 'review' }))
  await w.started()
  await w.finish(0, {})
  await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'Whole new brief', freshContext: true })
  await w.started(2)
  assert.equal(w.turns[1]?.input.resumeSessionId, undefined)
  assert.equal(w.turns[1]?.input.prompt, promptOf(/** @type {any} */ ({ task: 'Whole new brief', role: 'review', cwd: '/proj', runtimeMode: 'auto-accept-edits' })))
  await w.finish(1, {})
  await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'And then?' })
  await w.started(3)
  assert.equal(w.turns[2]?.input.resumeSessionId, 'agent-session-2')
})

test('thread_send refuses steer, an unknown or foreign thread, a bad mode, an empty message and a lowered ceiling', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  /** @param {Record<string, unknown>} input @param {import('../../daemon/orchestrator.mjs').Caller} [who] */
  const code = async (input, who = caller()) => /** @type {any} */ (await w.orchestrator.threadSend(who, { threadId: first.threadId, message: 'm', ...input })).error?.code
  assert.equal(await code({ mode: 'steer' }), 'invalid_input')
  assert.equal(await code({ mode: 'later' }), 'invalid_input')
  assert.equal(await code({ message: '  ' }), 'invalid_input')
  assert.equal(await code({ threadId: 'thread_nope0001' }), 'thread_not_found')
  assert.equal(await code({ threadId: '../tasks/x' }), 'thread_not_found')
  assert.equal(await code({ threadId: undefined }), 'thread_not_found')
  assert.equal(await code({}, caller('sess-2')), 'thread_not_found')
  assert.equal(await code({}, narrowed('sess-1', 'read-only')), 'runtime_mode_escalation_denied')
  await w.started()
  await settle()
  assert.equal(w.turns.length, 1)
  assert.equal(w.orchestrator.busy(), 1)
})

test('a thread_send retry with the same clientRequestId returns the same task and runs once', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  await w.started()
  await w.finish(0, {})
  const once = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'm', clientRequestId: 'follow-1' }))
  const again = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'm', clientRequestId: 'follow-1' }))
  assert.equal(again.taskId, once.taskId)
  await w.started(2)
  await settle()
  assert.equal(w.turns.length, 2)
})

test('task_cancel of a queued task takes it off the queue: it never runs and sends no notice', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  await w.started()
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'later' }))
  assert.deepEqual(await w.orchestrator.cancel(caller(), { taskId: sent.taskId }), { taskId: sent.taskId, status: 'cancelled' })
  assert.equal(w.orchestrator.busy(), 1)
  await w.finish(0, {})
  await settle()
  assert.equal(w.turns.length, 1)
  assert.deepEqual((await w.inbox()).map((notice) => notice.taskId), [first.taskId])
  assert.equal(/** @type {any} */ (await w.orchestrator.status(caller(), { taskId: sent.taskId })).status, 'cancelled')
})

test('a daemon stopping starts no queued task', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  await w.started()
  await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'later' })
  await w.orchestrator.stopAll()
  await settle()
  assert.equal(w.turns.length, 1)
})

test('a stopping daemon refuses new calls and starts no turn', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  await w.started()
  const stopped = w.orchestrator.stopAll()
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'more' }))
  const delegated = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'y' }))
  await stopped
  await settle()
  assert.equal(sent.error?.code, 'orchestrator_stopping')
  assert.equal(delegated.error?.code, 'orchestrator_stopping')
  assert.equal(w.turns.length, 1)
})

test('two restarts in a row run in the order they were sent', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  await w.started()
  const queued = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'queued', mode: 'queue' }))
  // The fake turn ends at once on abort, so hold both restarts in one tick, before the first task's end runs.
  const [r1, r2] = /** @type {any[]} */ (await Promise.all([
    w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'restart one', mode: 'restart' }),
    w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'restart two', mode: 'restart' }),
  ]))
  assert.equal(r1.delivery, 'restarted')
  await w.started(2)
  assert.equal(w.turns[1]?.input.prompt, 'restart one')
  await w.finish(1, {})
  await w.started(3)
  assert.equal(w.turns[2]?.input.prompt, 'restart two')
  await w.finish(2, {})
  await w.started(4)
  assert.equal(w.turns[3]?.input.prompt, 'queued')
  assert.ok(['restarted', 'queued'].includes(r2.delivery))
  assert.equal(queued.delivery, 'queued')
})

test('a thread_send retry carries its delivery; a clientRequestId another call used is refused', async () => {
  const w = await world()
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x', clientRequestId: 'round-1' }))
  const other = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'y' }))
  await w.started(2)
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'm', clientRequestId: 'follow-1' }))
  assert.equal(sent.delivery, 'queued')
  const again = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'm', clientRequestId: 'follow-1' }))
  assert.equal(again.taskId, sent.taskId)
  assert.equal(again.delivery, 'queued')
  assert.equal(again.next, RUNNING_TASK_NEXT)
  /** @param {Record<string, unknown>} input */
  const code = async (input) => /** @type {any} */ (await w.orchestrator.threadSend(caller(), { message: 'm', ...input })).error?.code
  assert.equal(await code({ threadId: first.threadId, clientRequestId: 'round-1' }), 'invalid_input')
  assert.equal(await code({ threadId: other.threadId, clientRequestId: 'follow-1' }), 'invalid_input')
  assert.equal(/** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'z', clientRequestId: 'follow-1' })).error?.code, 'invalid_input')
  assert.equal(w.orchestrator.busy(), 3)
})

test('thread_send on a thread whose task another live daemon runs fails thread_busy and starts nothing', async () => {
  const w = await world({ ownerAlive: true })
  const first = /** @type {any} */ (await w.orchestrator.delegate(caller(), { task: 'x' }))
  await w.started()
  await w.finish(0, {})
  const base = { parentSessionId: 'sess-1', title: 't', role: 'general', task: 't', cwd: '/proj', providerInstanceId: 'agy', model: null, options: {}, runtimeMode: 'auto-accept-edits', isolation: 'shared', createdAt: 1, summary: null, executedModel: null, refused: [], delivered: false }
  await w.store.save(/** @type {any} */ ({ ...base, taskId: 'task_else0001', threadId: first.threadId, status: 'running', ownerPid: 99 }))
  const sent = /** @type {any} */ (await w.orchestrator.threadSend(caller(), { threadId: first.threadId, message: 'm' }))
  assert.equal(sent.error?.code, 'thread_busy')
  await settle()
  assert.equal(w.turns.length, 1)
  assert.equal(w.orchestrator.busy(), 0)
})

test('on start, a queued follow-up a dead daemon left ends as interrupted with one notice', async () => {
  const w = await world()
  const base = { parentSessionId: 'sess-1', title: 'q', role: 'general', task: 'q', cwd: '/proj', providerInstanceId: 'agy', model: null, options: {}, runtimeMode: 'auto-accept-edits', isolation: 'shared', createdAt: 1, summary: null, executedModel: null, refused: [], delivered: false }
  await w.store.save(/** @type {any} */ ({ ...base, taskId: 'task_queu0002', threadId: 'thread_queu0001', status: 'queued', ownerPid: 99 }))
  await w.orchestrator.recover()
  assert.equal((await w.store.load('task_queu0002'))?.status, 'interrupted')
  const notices = await w.inbox()
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /task_queu0002 \(thread thread_queu0001\) \("q"\) on agy interrupted/)
})
