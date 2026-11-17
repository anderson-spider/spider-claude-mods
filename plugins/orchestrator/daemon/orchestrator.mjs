// The orchestrator: delegated tasks as T3 Code's orchestrator MCP server shapes them (delegate_task, task_status,
// task_cancel, orchestrator_capabilities), run on an ACP agent, kept as files, and announced to the parent session
// once when they end. Pure: the store, the turn, the probe and the provider's setup are injected.
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
 * @typedef {'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'} TaskStatus
 * @typedef {object} Task
 * @property {string} taskId
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
    title: task.title,
    status: task.status,
    workState: isTerminal(task.status) ? 'result_available' : 'working',
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
  const head = `Delegated task ${task.taskId} ("${task.title}") on ${task.providerInstanceId}${task.executedModel ? ` (${task.executedModel})` : ''}`
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
  /** @type {Map<string, AbortController>} */
  const running = new Map()
  /** @type {Map<string, Set<() => void>>} */
  const waiters = new Map()
  /** @type {{ at: number, value: any } | undefined} */
  let capabilitiesCache

  /** @param {Task} task */
  async function save(task) {
    await deps.store.save(task).catch((error) => deps.log?.(`saving ${task.taskId} failed: ${error}`))
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

  /** @param {Task} task @param {Settings} settings */
  async function run(task, settings) {
    const controller = new AbortController()
    running.set(task.taskId, controller)
    try {
      const agy = await deps.locate(settings.agyPath)
      if (typeof agy !== 'string') return Object.assign(task, { status: 'failed', error: agy.error })
      const notReady = await deps.prepare()
      if (notReady) return Object.assign(task, { status: 'failed', error: notReady })
      const result = await deps.runTurn({
        argv: deps.argvOf(agy),
        cwd: task.cwd,
        prompt: promptOf(task),
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
      await settle(task)
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

  /** A task of this parent, from memory or the files (another daemon's). @param {string} sessionId @param {unknown} taskId */
  async function own(sessionId, taskId) {
    const id = trimmed(taskId)
    if (!id) return undefined
    const task = tasks.get(id) ?? (await deps.store.load(id))
    return task && task.parentSessionId === sessionId ? task : undefined
  }

  return {
    /** How many tasks are running, so the daemon stays up for them. */
    busy: () => running.size,

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
        maxWaitMs: MAX_WAIT_MS,
      }
    },

    /**
     * @param {Caller} caller
     * @param {Record<string, unknown>} input
     */
    async delegate(caller, input) {
      const text = trimmed(input.task)
      if (!text) return failure('invalid_input', 'Give the task: everything the child needs, since it does not see this conversation.')
      if (text.length > MAX_TASK_CHARS) return failure('invalid_input', `The task is over ${MAX_TASK_CHARS} characters; put long material in a file and name it.`)
      const clientRequestId = trimmed(input.clientRequestId)
      if (clientRequestId && clientRequestId.length > 200) return failure('invalid_input', 'clientRequestId is over 200 characters.')
      if (clientRequestId) {
        const earlier = [...tasks.values(), ...(await deps.store.all())].find((task) => task.parentSessionId === caller.sessionId && task.clientRequestId === clientRequestId)
        if (earlier) return resultOf(tasks.get(earlier.taskId) ?? earlier, isTerminal(earlier.status) ? {} : { next: RUNNING_TASK_NEXT })
      }
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

      /** @type {Task} */
      const task = {
        taskId: newId(),
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
      tasks.set(task.taskId, task)
      await deps.store.save(task)
      void run(task, caller.settings)
      if (mode === 'async') return resultOf(task, { waitTimedOut: false, next: RUNNING_TASK_NEXT })
      const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? Math.min(input.timeoutMs, MAX_WAIT_MS) : MAX_WAIT_MS
      const ended = await waitFor(task, timeoutMs)
      return ended ? resultOf(task, { waitTimedOut: false }) : resultOf(task, { waitTimedOut: true, next: RUNNING_TASK_NEXT })
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
