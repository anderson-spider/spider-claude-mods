// The orchestrator: delegated tasks as T3 Code's orchestrator MCP server shapes them (delegate_task, task_status,
// task_cancel, thread_send, orchestrator_capabilities), run on an ACP agent, kept as files, and announced to the parent
// session once when they end. Each delegation opens a thread, one agent session; a thread_send is a later task on it,
// run one at a time in order. Pure: the store, the turn, the probe and the provider's setup are injected.
import { RUNTIME_MODES, isRuntimeMode, rankOf } from './policy.mjs'
import { AGY, AGY_DRIVER } from './agy.mjs'

/**
 * @import { RuntimeMode } from './policy.mjs'
 * @import { Refusal, TurnInput, TurnResult } from './acp.mjs'
 * @import { Store } from './store.mjs'
 */

export const ROLES = /** @type {const} */ (['implementation', 'research', 'review', 'design', 'test', 'general'])
export const TERMINAL = /** @type {const} */ (['completed', 'failed', 'cancelled', 'interrupted'])
/** The longest a wait holds a tool call, as in T3 Code: a timeout leaves the task running. */
export const MAX_WAIT_MS = 45_000
/** The text a running task's result carries: its end wakes the parent, which neither waits nor polls. */
export const RUNNING_TASK_NEXT = 'Completion wakes this thread. Do not wait on it or poll it. Continue other work, and end your turn when none is left.'
// How much of a result a notice carries; task_status has all of it.
const NOTICE_CHARS = 20_000
const MAX_TASK_CHARS = 200_000
// How long the models agy offers are kept before a capabilities call asks again.
const CAPABILITIES_MS = 10 * 60_000

/**
 * @typedef {object} Thread
 * @property {string} threadId
 * @property {string} parentSessionId
 * @property {string} cwd
 * @property {string} role
 * @property {string} providerInstanceId
 * @property {string | null} model
 * @property {{ effort?: string }} options
 * @property {RuntimeMode} runtimeMode fixed at delegation: a follow-up never widens it
 * @property {string} [agentSessionId] the agent's session, resumed by each follow-up
 * @property {number} createdAt
 * @typedef {'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'} TaskStatus
 * @typedef {object} Task
 * @property {string} taskId
 * @property {string} threadId
 * @property {boolean} [fresh] a follow-up that starts a new agent session (freshContext)
 * @property {string} parentSessionId
 * @property {string} [clientRequestId]
 * @property {string} title
 * @property {string} role
 * @property {string} task
 * @property {string} cwd
 * @property {string} providerInstanceId
 * @property {string | null} model
 * @property {{ effort?: string }} options
 * @property {RuntimeMode} runtimeMode
 * @property {'shared'} isolation
 * @property {TaskStatus} status
 * @property {number} createdAt
 * @property {number} [endedAt]
 * @property {string | null} summary
 * @property {string} [error]
 * @property {string | null} executedModel
 * @property {string} [agentSessionId]
 * @property {string} [progress]
 * @property {Refusal[]} refused
 * @property {'started' | 'queued' | 'restarted'} [delivery] how a thread_send placed it, returned again by a retry
 * @property {boolean} delivered whether the parent has the result (a wait returned it, task_status read it, or it was cancelled)
 * @property {number} ownerPid the daemon running it
 * @typedef {{ agyPath?: string, maxRuntimeMode: RuntimeMode, taskMinutes: number }} Settings
 * @typedef {{ sessionId: string, cwd: string, settings: Settings }} Caller
 * @typedef {{ code: string, message: string }} Failure
 * @typedef {object} OrchestratorDeps
 * @property {Store} store
 * @property {(input: TurnInput) => Promise<TurnResult>} runTurn
 * @property {(input: { argv: string[], cwd: string }) => Promise<{ models: { id: string, name: string }[], currentModel: string | null, efforts: string[] } | { error: string }>} probe
 * @property {(agyPath: string | undefined) => Promise<string | { error: string }>} locate
 * @property {(agy: string) => string[]} argvOf
 * @property {() => Promise<string | undefined>} prepare the provider's profile; resolves an error, or undefined when ready
 * @property {string} probeDir an empty folder the probe's session starts in
 * @property {string} version
 * @property {number} pid
 * @property {(pid: number) => boolean} isAlive
 * @property {() => number} [now]
 * @property {() => string} [newId]
 * @property {(text: string) => void} [log]
 */

/** @param {unknown} value */
const trimmed = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
/** @param {string} code @param {string} message @returns {{ error: Failure }} */
const failure = (code, message) => ({ error: { code, message } })
/** @param {TaskStatus} status */
const isTerminal = (status) => /** @type {readonly string[]} */ (TERMINAL).includes(status)

/** What the child is told of its place: the folder and what its runtime mode lets it do. */
/** @param {Task} task */
export function promptOf(task) {
  const rules = {
    'read-only': 'Read only: do not edit files or run commands; any such action is refused.',
    'approval-required': 'Read only: do not edit files or run commands; any such action is refused.',
    'auto-accept-edits': `You may edit files inside ${task.cwd}; edits elsewhere and commands are refused.`,
    'full-access': 'You may edit files and run commands.',
  }[task.runtimeMode]
  return `${task.task}\n\n---\nYou are a delegated ${task.role} subagent working in ${task.cwd}. ${rules} You cannot ask questions: decide, and say what you assumed. End with your result.`
}

/** @param {Task} task */
export function resultOf(task, extra = {}) {
  return {
    taskId: task.taskId,
    threadId: task.threadId,
    title: task.title,
    status: task.status,
    workState: isTerminal(task.status) ? 'result_available' : task.status === 'queued' ? 'queued' : 'working',
    providerInstanceId: task.providerInstanceId,
    model: task.model,
    executedModel: task.executedModel,
    options: task.options,
    runtimeMode: task.runtimeMode,
    isolation: task.isolation,
    summary: task.summary,
    ...(task.error ? { error: task.error } : {}),
    ...(!isTerminal(task.status) && task.progress ? { progress: task.progress } : {}),
    ...(task.refused.length ? { refusedActions: task.refused } : {}),
    ...extra,
  }
}

/** The notice the parent session gets once a task ends. @param {Task} task */
export function noticeOf(task) {
  // A task an earlier version of the plugin ran has no thread.
  const head = `Delegated task ${task.taskId}${task.threadId ? ` (thread ${task.threadId})` : ''} ("${task.title}") on ${task.providerInstanceId}${task.executedModel ? ` (${task.executedModel})` : ''}`
  const refused = task.refused.length ? `\n\nRefused actions (${task.runtimeMode}): ${task.refused.map((r) => `${r.title} (${r.reason})`).join('; ')}` : ''
  if (task.status !== 'completed') return `${head} ${task.status}: ${task.error ?? 'no result'}${task.summary ? `\n\nPartial result:\n\n${task.summary.slice(0, NOTICE_CHARS)}` : ''}${refused}`
  const summary = task.summary ?? ''
  const cut = summary.length > NOTICE_CHARS ? `${summary.slice(0, NOTICE_CHARS)}\n\n[cut at ${NOTICE_CHARS} characters; task_status has the whole result]` : summary
  return `${head} completed. Its result:\n\n${cut}${refused}`
}

/** @param {OrchestratorDeps} deps */
export function createOrchestrator(deps) {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `task_${now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
  /** @type {Map<string, Task>} the tasks this daemon runs or ran */
  const tasks = new Map()
  /** @type {Map<string, Thread>} */
  const threads = new Map()
  /** @type {Map<string, AbortController>} */
  const running = new Map()
  /** @type {Map<string, string>} each thread's running task: one turn at a time on an agent session */
  const active = new Map()
  /** @type {Map<string, { task: Task, settings: Settings, restart?: boolean }[]>} each thread's tasks waiting for its turn */
  const queues = new Map()
  /** @type {Set<string>} tasks a restart replaces */
  const replaced = new Set()
  /** @type {Map<string, Set<() => void>>} */
  const waiters = new Map()
  /** @type {{ at: number, value: any } | undefined} */
  let capabilitiesCache
  let stopping = false

  /** @param {Task} task */
  async function save(task) {
    await deps.store.save(task).catch((error) => deps.log?.(`saving ${task.taskId} failed: ${error}`))
  }
  /** @param {Thread} thread */
  async function saveThread(thread) {
    await deps.store.saveThread(thread).catch((error) => deps.log?.(`saving ${thread.threadId} failed: ${error}`))
  }

  /** A task ended: wake a wait on it, else leave the parent a notice. @param {Task} task */
  async function settle(task) {
    task.endedAt = now()
    const waiting = waiters.get(task.taskId)
    if (waiting?.size) task.delivered = true
    await save(task)
    for (const wake of waiting ?? []) wake()
    waiters.delete(task.taskId)
    if (!task.delivered) await deps.store.notify(task.parentSessionId, task.taskId, noticeOf(task)).catch((error) => deps.log?.(`notice for ${task.taskId} failed: ${error}`))
  }

  /**
   * Starts a task now, or queues it behind its thread's running one. A restart goes ahead of the queued tasks but
   * behind earlier restarts still waiting, so two restarts in a row run in the order they were sent.
   * @param {Task} task @param {Settings} settings @param {boolean} [restart]
   */
  function schedule(task, settings, restart = false) {
    // A daemon stopping spawns no agent it could not stop: the task waits, and the next daemon marks it interrupted.
    if (!active.has(task.threadId) && !stopping) {
      active.set(task.threadId, task.taskId)
      void run(task, settings)
      return
    }
    task.status = 'queued'
    const queue = queues.get(task.threadId) ?? []
    queues.set(task.threadId, queue)
    if (!restart) return void queue.push({ task, settings })
    const at = queue.findIndex((entry) => !entry.restart)
    queue.splice(at < 0 ? queue.length : at, 0, { task, settings, restart: true })
  }

  /** @param {string} threadId */
  function startNext(threadId) {
    active.delete(threadId)
    // A daemon stopping starts no queued task: the next one marks it interrupted.
    if (stopping) return
    const next = queues.get(threadId)?.shift()
    if (!next) return void queues.delete(threadId)
    next.task.status = 'starting'
    void save(next.task)
    schedule(next.task, next.settings)
  }

  /** @param {Task} task @param {Settings} settings */
  async function run(task, settings) {
    const controller = new AbortController()
    running.set(task.taskId, controller)
    const thread = threads.get(task.threadId) ?? (await deps.store.loadThread(task.threadId))
    try {
      if (!thread) return Object.assign(task, { status: 'failed', error: `Thread ${task.threadId} is gone.` })
      threads.set(thread.threadId, thread)
      const agy = await deps.locate(settings.agyPath)
      if (typeof agy !== 'string') return Object.assign(task, { status: 'failed', error: agy.error })
      const notReady = await deps.prepare()
      if (notReady) return Object.assign(task, { status: 'failed', error: notReady })
      const resume = task.fresh ? undefined : thread.agentSessionId
      const result = await deps.runTurn({
        argv: deps.argvOf(agy),
        cwd: task.cwd,
        // A resumed session has the brief and its rules: a follow-up is the message alone.
        prompt: resume ? task.task : promptOf(task),
        ...(resume ? { resumeSessionId: resume } : {}),
        ...(task.model ? { model: task.model } : {}),
        ...(task.options.effort ? { effort: task.options.effort } : {}),
        runtimeMode: task.runtimeMode,
        deadlineMs: settings.taskMinutes * 60_000,
        signal: controller.signal,
        clientVersion: deps.version,
        onUpdate(update) {
          if (update.sessionId) {
            task.agentSessionId = update.sessionId
            if (task.status === 'starting') task.status = 'running'
            if (thread.agentSessionId !== update.sessionId) {
              thread.agentSessionId = update.sessionId
              void saveThread(thread)
            }
          }
          if (update.executedModel !== undefined) task.executedModel = update.executedModel
          if (update.progress) task.progress = update.progress
          void save(task)
        },
      })
      Object.assign(task, {
        status: result.status,
        summary: result.summary || null,
        refused: result.refused,
        executedModel: result.executedModel ?? task.executedModel,
        ...(result.sessionId ? { agentSessionId: result.sessionId } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
    } catch (error) {
      Object.assign(task, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    } finally {
      running.delete(task.taskId)
      // A turn a restart replaced ends as interrupted, and the parent, who asked for it, gets no notice of it.
      if (replaced.delete(task.taskId)) Object.assign(task, { status: 'interrupted', error: 'Replaced by a thread_send restart.', delivered: true })
      await settle(task)
      startNext(task.threadId)
    }
  }

  /** @param {Task} task @param {number} timeoutMs */
  function waitFor(task, timeoutMs) {
    if (isTerminal(task.status)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const set = waiters.get(task.taskId) ?? new Set()
      waiters.set(task.taskId, set)
      const wake = () => (clearTimeout(timer), resolve(true))
      const timer = setTimeout(() => (set.delete(wake), resolve(false)), timeoutMs)
      set.add(wake)
    })
  }

  /** The result of a call that may wait: at once with next, or once the task ends or the wait times out. @param {Task} task @param {boolean} wait @param {unknown} timeout @param {object} [extra] */
  async function answer(task, wait, timeout, extra = {}) {
    if (!wait) return resultOf(task, { ...extra, waitTimedOut: false, next: RUNNING_TASK_NEXT })
    const timeoutMs = typeof timeout === 'number' && timeout > 0 ? Math.min(timeout, MAX_WAIT_MS) : MAX_WAIT_MS
    const ended = await waitFor(task, timeoutMs)
    return ended ? resultOf(task, { ...extra, waitTimedOut: false }) : resultOf(task, { ...extra, waitTimedOut: true, next: RUNNING_TASK_NEXT })
  }

  /** A task of this parent, from memory or the files (another daemon's). @param {string} sessionId @param {unknown} taskId */
  async function own(sessionId, taskId) {
    const id = trimmed(taskId)
    if (!id) return undefined
    const task = tasks.get(id) ?? (await deps.store.load(id))
    return task && task.parentSessionId === sessionId ? task : undefined
  }

  /** An earlier task of this parent with the same clientRequestId. @param {string} sessionId @param {string | undefined} clientRequestId */
  async function replayed(sessionId, clientRequestId) {
    if (!clientRequestId) return undefined
    const earlier = [...tasks.values(), ...(await deps.store.all())].find((task) => task.parentSessionId === sessionId && task.clientRequestId === clientRequestId)
    return earlier && (tasks.get(earlier.taskId) ?? earlier)
  }
  /** A retry's result: the earlier task as it is now. @param {Task} task @param {object} [extra] */
  const replayOf = (task, extra = {}) => resultOf(task, { ...extra, ...(isTerminal(task.status) ? {} : { next: RUNNING_TASK_NEXT }) })
  /** Whether a task opened its thread (a delegate_task) rather than followed up on it. A task with no thread is older. @param {Task} task */
  const opensThread = (task) => !task.threadId || task.threadId === task.taskId.replace(/^task_/, 'thread_')
  const STOPPING = () => failure('orchestrator_stopping', 'The orchestrator daemon is stopping; call again in a moment, and a new daemon takes the call.')

  return {
    /** How many tasks are running, so the daemon stays up for them. */
    busy: () => running.size + [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),

    /**
     * On start: a task the files show running whose daemon is gone ended with it. One a live daemon runs is its own.
     */
    async recover() {
      for (const task of await deps.store.all()) {
        if (isTerminal(task.status) || (task.ownerPid !== deps.pid && deps.isAlive(task.ownerPid))) continue
        Object.assign(task, { status: 'interrupted', error: 'The orchestrator stopped before the task ended.' })
        await settle(task)
      }
    },

    /** Stops every running task (the daemon is stopping). */
    async stopAll() {
      stopping = true
      for (const controller of running.values()) controller.abort()
      const deadline = now() + 8_000
      while (running.size && now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
    },

    /** @param {Caller} caller */
    async capabilities(caller) {
      const fresh = capabilitiesCache && now() - capabilitiesCache.at < CAPABILITIES_MS ? capabilitiesCache.value : undefined
      let agyInfo = fresh
      if (!agyInfo) {
        const agy = await deps.locate(caller.settings.agyPath)
        const notReady = typeof agy === 'string' ? await deps.prepare() : undefined
        const probed = typeof agy !== 'string' ? agy : notReady ? { error: notReady } : await deps.probe({ argv: deps.argvOf(agy), cwd: deps.probeDir })
        agyInfo = 'error' in probed ? { available: false, reason: probed.error } : { available: true, ...probed }
        if (agyInfo.available) capabilitiesCache = { at: now(), value: agyInfo }
      }
      const ceiling = caller.settings.maxRuntimeMode
      return {
        providers: [
          {
            providerInstanceId: AGY,
            driverKind: AGY_DRIVER,
            name: 'Antigravity CLI (agy)',
            available: agyInfo.available,
            ...(agyInfo.available
              ? { models: agyInfo.models, defaultModel: agyInfo.currentModel, options: [{ id: 'effort', values: agyInfo.efforts }] }
              : { reason: agyInfo.reason }),
          },
        ],
        runtimeModes: RUNTIME_MODES.filter((mode) => rankOf(mode) <= rankOf(ceiling)),
        defaultRuntimeMode: ceiling,
        isolation: ['shared'],
        threadSendModes: ['auto', 'queue', 'restart'],
        maxWaitMs: MAX_WAIT_MS,
      }
    },

    /**
     * @param {Caller} caller
     * @param {Record<string, unknown>} input
     */
    async delegate(caller, input) {
      if (stopping) return STOPPING()
      const text = trimmed(input.task)
      if (!text) return failure('invalid_input', 'Give the task: everything the child needs, since it does not see this conversation.')
      if (text.length > MAX_TASK_CHARS) return failure('invalid_input', `The task is over ${MAX_TASK_CHARS} characters; put long material in a file and name it.`)
      const clientRequestId = trimmed(input.clientRequestId)
      if (clientRequestId && clientRequestId.length > 200) return failure('invalid_input', 'clientRequestId is over 200 characters.')
      const earlier = await replayed(caller.sessionId, clientRequestId)
      if (earlier && !opensThread(earlier)) return failure('invalid_input', `clientRequestId ${clientRequestId} is a thread_send's (${earlier.taskId}); give this delegation its own.`)
      if (earlier) return replayOf(earlier)
      const provider = trimmed(input.providerInstanceId)
      if (provider && provider !== AGY && provider !== AGY_DRIVER) {
        return failure('provider_unavailable', `${provider} is not a provider here; the one provider is ${AGY}.`)
      }
      const model = trimmed(input.model)
      if (model && !/^[\w.:/-]{1,100}$/.test(model)) return failure('invalid_input', `${model} is not a model id.`)
      const effort = trimmed(input.effort)?.toLowerCase()
      const efforts = capabilitiesCache?.value?.efforts ?? ['low', 'medium', 'high']
      if (effort && !efforts.includes(effort)) return failure('invalid_input', `effort ${effort} is not offered; agy takes ${efforts.join(', ')}.`)
      const isolation = trimmed(input.isolation) ?? 'shared'
      if (isolation === 'worktree') return failure('isolation_unavailable', 'Worktree isolation is not available yet; delegate with isolation "shared".')
      if (isolation !== 'shared') return failure('invalid_input', `isolation ${isolation} is not shared or worktree.`)
      const asked = trimmed(input.runtimeMode) ?? 'inherit'
      const ceiling = caller.settings.maxRuntimeMode
      if (asked !== 'inherit' && !isRuntimeMode(asked)) return failure('invalid_input', `runtimeMode ${asked} is not inherit or one of ${RUNTIME_MODES.join(', ')}.`)
      const runtimeMode = asked === 'inherit' ? ceiling : /** @type {RuntimeMode} */ (asked)
      if (rankOf(runtimeMode) > rankOf(ceiling)) return failure('runtime_mode_escalation_denied', `${runtimeMode} is broader than this session's ceiling, ${ceiling} (the maxRuntimeMode option).`)
      const role = trimmed(input.role) ?? 'general'
      if (!(/** @type {readonly string[]} */ (ROLES)).includes(role)) return failure('invalid_input', `role ${role} is not one of ${ROLES.join(', ')}.`)
      const mode = trimmed(input.mode) ?? 'async'
      if (mode !== 'async' && mode !== 'wait') return failure('invalid_input', `mode ${mode} is not async or wait.`)

      const taskId = newId()
      /** @type {Thread} */
      const thread = {
        threadId: taskId.replace(/^task_/, 'thread_'),
        parentSessionId: caller.sessionId,
        cwd: caller.cwd,
        role,
        providerInstanceId: AGY,
        model: model ?? null,
        options: effort ? { effort } : {},
        runtimeMode,
        createdAt: now(),
      }
      /** @type {Task} */
      const task = {
        taskId,
        threadId: thread.threadId,
        parentSessionId: caller.sessionId,
        ...(clientRequestId ? { clientRequestId } : {}),
        title: (trimmed(input.title) ?? text.split('\n')[0] ?? '').slice(0, 120),
        role,
        task: text,
        cwd: caller.cwd,
        providerInstanceId: AGY,
        model: model ?? null,
        options: effort ? { effort } : {},
        runtimeMode,
        isolation: 'shared',
        status: 'starting',
        createdAt: now(),
        summary: null,
        executedModel: null,
        refused: [],
        delivered: false,
        ownerPid: deps.pid,
      }
      threads.set(thread.threadId, thread)
      tasks.set(task.taskId, task)
      await deps.store.saveThread(thread)
      await deps.store.save(task)
      schedule(task, caller.settings)
      if (task.status === 'queued') await save(task)
      return answer(task, mode === 'wait', input.timeoutMs)
    },

    /**
     * A follow-up on a thread: a new task on the same agent session, after its running and queued ones (auto, queue)
     * or in place of the running one (restart). The earlier tasks' results stay as they were.
     * @param {Caller} caller
     * @param {Record<string, unknown>} input
     */
    async threadSend(caller, input) {
      if (stopping) return STOPPING()
      const id = trimmed(input.threadId)
      const thread = id ? (threads.get(id) ?? (await deps.store.loadThread(id))) : undefined
      if (!thread || thread.parentSessionId !== caller.sessionId) return failure('thread_not_found', `No thread ${String(input.threadId)} of this session.`)
      const message = trimmed(input.message)
      if (!message) return failure('invalid_input', 'Give the message for the thread.')
      if (message.length > MAX_TASK_CHARS) return failure('invalid_input', `The message is over ${MAX_TASK_CHARS} characters; put long material in a file and name it.`)
      const clientRequestId = trimmed(input.clientRequestId)
      if (clientRequestId && clientRequestId.length > 200) return failure('invalid_input', 'clientRequestId is over 200 characters.')
      const earlier = await replayed(caller.sessionId, clientRequestId)
      // A retry is of a send on this thread; an id another call used is a mistake, not that call's success.
      if (earlier && (earlier.threadId !== thread.threadId || opensThread(earlier))) {
        return failure('invalid_input', `clientRequestId ${clientRequestId} is another call's (${earlier.taskId}); give this message its own.`)
      }
      if (earlier) return replayOf(earlier, { delivery: earlier.delivery ?? (earlier.status === 'queued' ? 'queued' : 'started') })
      const mode = trimmed(input.mode) ?? 'auto'
      if (mode === 'steer') return failure('invalid_input', 'steer is not available: an ACP agent takes no prompt during a turn. Use queue, or restart to replace the running turn.')
      if (mode !== 'auto' && mode !== 'queue' && mode !== 'restart') return failure('invalid_input', `mode ${mode} is not auto, queue or restart.`)
      // A thread whose tasks another live daemon runs stays with it: two agents on one session would clash.
      // The thread's mode was fixed under the ceiling of its time; a ceiling lowered since then holds for its follow-ups.
      const ceiling = caller.settings.maxRuntimeMode
      if (rankOf(thread.runtimeMode) > rankOf(ceiling)) return failure('runtime_mode_escalation_denied', `${thread.threadId} runs in ${thread.runtimeMode}, broader than this session's ceiling, ${ceiling} (the maxRuntimeMode option); delegate a new task instead.`)
      const elsewhere = (await deps.store.all()).some((task) => task.threadId === thread.threadId && !isTerminal(task.status) && task.ownerPid !== deps.pid && deps.isAlive(task.ownerPid))
      if (elsewhere) return failure('thread_busy', `${thread.threadId} has a task running in another orchestrator daemon (an earlier version of the plugin); send once it ends.`)
      threads.set(thread.threadId, thread)

      /** @type {Task} */
      const task = {
        taskId: newId(),
        threadId: thread.threadId,
        // Whether the thread has an agent session yet is read when the task starts: a task queued behind the first one
        // resumes the session that one opens.
        ...(input.freshContext === true ? { fresh: true } : {}),
        parentSessionId: caller.sessionId,
        ...(clientRequestId ? { clientRequestId } : {}),
        title: (trimmed(input.title) ?? message.split('\n')[0] ?? '').slice(0, 120),
        role: thread.role,
        task: message,
        cwd: thread.cwd,
        providerInstanceId: thread.providerInstanceId,
        model: thread.model,
        options: thread.options,
        runtimeMode: thread.runtimeMode,
        isolation: 'shared',
        status: 'starting',
        createdAt: now(),
        summary: null,
        executedModel: null,
        refused: [],
        delivered: false,
        ownerPid: deps.pid,
      }
      tasks.set(task.taskId, task)
      const runningId = active.get(thread.threadId)
      /** @type {'started' | 'queued' | 'restarted'} */
      let delivery = runningId ? 'queued' : 'started'
      // A task whose turn has ended and is being settled is not restarted: the new one starts right after it.
      if (mode === 'restart' && runningId && running.has(runningId)) {
        replaced.add(runningId)
        running.get(runningId)?.abort()
        delivery = 'restarted'
      }
      schedule(task, caller.settings, mode === 'restart')
      // A daemon that began stopping during this call queued it.
      task.delivery = delivery === 'started' && task.status === 'queued' ? 'queued' : delivery
      await save(task)
      return answer(task, false, undefined, { delivery: task.delivery })
    },

    /** @param {Caller} caller @param {Record<string, unknown>} input */
    async status(caller, input) {
      const task = await own(caller.sessionId, input.taskId)
      if (!task) return failure('task_not_found', `No delegated task ${String(input.taskId)} of this session.`)
      if (isTerminal(task.status) && !task.delivered) {
        task.delivered = true
        await save(task)
        await deps.store.unnotify(task.parentSessionId, task.taskId).catch(() => undefined)
      }
      return resultOf(task)
    },

    /** @param {Caller} caller @param {Record<string, unknown>} input */
    async cancel(caller, input) {
      const task = await own(caller.sessionId, input.taskId)
      if (!task) return failure('task_not_found', `No delegated task ${String(input.taskId)} of this session.`)
      if (isTerminal(task.status)) return { taskId: task.taskId, status: task.status }
      const queue = queues.get(task.threadId)
      const queuedAt = queue?.findIndex((entry) => entry.task.taskId === task.taskId) ?? -1
      if (queue && queuedAt >= 0) {
        queue.splice(queuedAt, 1)
        Object.assign(task, { status: 'cancelled', delivered: true })
        await settle(task)
        return { taskId: task.taskId, status: 'cancelled' }
      }
      const controller = running.get(task.taskId)
      if (!controller && task.ownerPid !== deps.pid && deps.isAlive(task.ownerPid)) {
        return failure('task_not_cancellable', `${task.taskId} runs in another orchestrator daemon (an earlier version of the plugin); it ends on its own.`)
      }
      // Cancelling disposes of the parent's notice, as in T3 Code.
      task.delivered = true
      const reason = trimmed(input.reason)
      if (reason) task.error = `Cancelled: ${reason.slice(0, 2_000)}`
      await save(task)
      if (controller) {
        controller.abort()
        return { taskId: task.taskId, status: 'cancel_requested' }
      }
      // Its daemon is gone: it ended with it.
      Object.assign(task, { status: 'cancelled' })
      await settle(task)
      return { taskId: task.taskId, status: 'cancelled' }
    },
  }
}
