// One task's turn on an ACP agent (agy acp): spawn it in its own process group, start a session, set the model and
// effort, send the prompt, answer its permission requests by the runtime mode, and stop it, whatever happens.
import { spawn } from 'node:child_process'
import { RpcError, peer } from './jsonrpc.mjs'
import { dispositionOf, outcomeOf } from './policy.mjs'

/** @import { RuntimeMode } from './policy.mjs' */

// How long an agent gets to end its turn after session/cancel, and to exit after SIGTERM, before SIGKILL.
const CANCEL_GRACE_MS = 5_000
const EXIT_GRACE_MS = 2_000
// What stays of the agent's stderr for an error.
const STDERR_KEEP = 4_000

/**
 * The prompt sent when a turn ended empty after the client refused an action: agy ends its turn at each refusal, and
 * on this prompt goes on with the task, so it is sent again after each new refusal, up to MAX_RETRIES times.
 */
export const RETRY_PROMPT =
  'The client refused that action under its permission rules. Do not try it again, nor any other action of that kind: go on with what you can do, then answer, saying what you could not do.'
export const MAX_RETRIES = 4

/**
 * @typedef {{ kind: string, title: string, reason: string }} Refusal
 * @typedef {object} TurnInput
 * @property {string[]} argv
 * @property {string} cwd
 * @property {Record<string, string | undefined>} [env]
 * @property {string} prompt
 * @property {string} [resumeSessionId] an agent session to go on with (`session/resume`, which replays nothing), else a new one
 * @property {string} [model]
 * @property {string} [effort]
 * @property {RuntimeMode} runtimeMode
 * @property {number} deadlineMs how long the turn may run in all
 * @property {AbortSignal} [signal] aborted on task_cancel
 * @property {(update: { sessionId?: string, executedModel?: string | null, progress?: string }) => void} [onUpdate]
 * @property {string} [clientVersion]
 * @property {(path: string) => string | undefined} [canonical]
 * @typedef {object} TurnResult
 * @property {'completed' | 'failed' | 'cancelled'} status
 * @property {string} summary the agent's answer, empty on failure
 * @property {string} [error]
 * @property {'model_unavailable' | 'timed_out' | 'agent_error'} [errorKind]
 * @property {string} [sessionId]
 * @property {string | null} executedModel
 * @property {Refusal[]} refused
 */

/** @param {unknown} error */
const messageOf = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 2_000)

/**
 * @param {TurnInput} input
 * @returns {Promise<TurnResult>}
 */
export async function runTurn(input) {
  const [command = '', ...args] = input.argv
  const child = spawn(command, args, { cwd: input.cwd, env: input.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  let stderr = ''
  let exited = false
  /** @type {Refusal[]} */
  const refused = []
  let text = ''
  let collecting = false
  let sessionId = /** @type {string | undefined} */ (undefined)
  let executedModel = /** @type {string | null} */ (null)
  let timedOut = false
  let cancelled = false

  const rpc = peer({
    write: (line) => void (child.stdin.writable && child.stdin.write(line)),
    async onRequest(method, params) {
      if (method === 'session/request_permission') {
        const toolCall = params?.toolCall
        const disposition = dispositionOf(input.runtimeMode, input.cwd, toolCall, input.canonical)
        if (disposition !== 'allow') {
          refused.push({
            kind: typeof toolCall?.kind === 'string' ? toolCall.kind : 'other',
            title: String(toolCall?.title ?? toolCall?.name ?? 'an action').slice(0, 200),
            reason: disposition === 'ask' ? `needs approval in ${input.runtimeMode}` : input.runtimeMode === 'read-only' ? 'read-only' : 'outside the work folder',
          })
        }
        return outcomeOf(disposition, params?.options)
      }
      // The client offers no file system, terminal or other methods: the agent uses its own tools, behind the requests above.
      throw new RpcError(-32601, `${method} is not offered by this client`)
    },
    onNotification(method, params) {
      if (method !== 'session/update') return
      const update = params?.update
      if (!collecting || !update) return
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += String(update.content.text ?? '')
      else if (update.sessionUpdate === 'tool_call' && typeof update.title === 'string') input.onUpdate?.({ progress: update.title.slice(0, 200) })
    },
  })
  const stopped = new Promise((resolve) => child.once('exit', resolve))
  child.on('error', (error) => rpc.close(error))
  child.once('exit', (code, signal) => {
    exited = true
    rpc.close(new Error(`agy exited (${signal ?? `code ${code}`})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`))
  })
  child.stdout.setEncoding('utf8').on('data', (chunk) => rpc.feed(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk) => void (stderr = (stderr + chunk).slice(-STDERR_KEEP)))
  child.stdin.on('error', () => {})

  /** @param {NodeJS.Signals} signal */
  const killGroup = (signal) => {
    if (exited || child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  let cancelTimer = /** @type {NodeJS.Timeout | undefined} */ (undefined)
  const cancelTurn = () => {
    if (sessionId) rpc.notify('session/cancel', { sessionId })
    cancelTimer ??= setTimeout(() => killGroup('SIGKILL'), CANCEL_GRACE_MS)
  }
  const deadline = setTimeout(() => ((timedOut = true), cancelTurn()), input.deadlineMs)
  const onAbort = () => ((cancelled = true), cancelTurn())
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted) onAbort()

  /** @param {Partial<TurnResult>} result @returns {TurnResult} */
  const end = (result) => ({ status: 'failed', summary: '', sessionId, executedModel, refused, ...result })
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'spider-orchestrator', version: input.clientVersion ?? '0' },
    })
    let session
    if (input.resumeSessionId) {
      try {
        session = { sessionId: input.resumeSessionId, ...(await rpc.request('session/resume', { sessionId: input.resumeSessionId, cwd: input.cwd, mcpServers: [] })) }
      } catch (error) {
        if (cancelled) return end({ status: 'cancelled' })
        if (timedOut) return end({ error: 'The task timed out.', errorKind: 'timed_out' })
        return end({ error: `agy could not resume its session: ${messageOf(error)} Send with freshContext to start a new one.`, errorKind: 'agent_error' })
      }
    } else session = await rpc.request('session/new', { cwd: input.cwd, mcpServers: [] })
    sessionId = typeof session?.sessionId === 'string' ? session.sessionId : undefined
    if (!sessionId) return end({ error: 'agy started no session.', errorKind: 'agent_error' })
    executedModel = typeof session?.models?.currentModelId === 'string' ? session.models.currentModelId : null
    input.onUpdate?.({ sessionId, executedModel })
    if (cancelled || timedOut) return end(cancelled ? { status: 'cancelled' } : { error: 'The task timed out.', errorKind: 'timed_out' })
    // The agent's own mode stays its default, which asks before edits and commands; the runtime mode is the client's.
    // A resumed session lists no modes: it is set all the same.
    const modes = session?.modes?.availableModes
    if (input.resumeSessionId || (Array.isArray(modes) && modes.some((mode) => mode?.id === 'default'))) {
      await rpc.request('session/set_mode', { sessionId, modeId: 'default' }).catch(() => undefined)
    }
    if (input.model) {
      try {
        await rpc.request('session/set_model', { sessionId, modelId: input.model })
      } catch (error) {
        return end({ error: messageOf(error), errorKind: 'model_unavailable' })
      }
      executedModel = input.model
      input.onUpdate?.({ executedModel })
    }
    if (input.effort) {
      try {
        await rpc.request('session/set_config_option', { sessionId, configId: 'thought_level', value: input.effort })
      } catch (error) {
        return end({ error: messageOf(error), errorKind: 'model_unavailable' })
      }
    }
    collecting = true
    let seen = refused.length
    let turn = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] })
    // agy ends its turn, with no text, at each action the client refuses: prompt it on while each turn adds a refusal.
    for (let retry = 0; retry < MAX_RETRIES && turn?.stopReason === 'end_turn' && !text.trim() && refused.length > seen && !cancelled && !timedOut; retry++) {
      seen = refused.length
      turn = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: RETRY_PROMPT }] })
    }
    if (timedOut) return end({ summary: text.trim(), error: 'The task timed out.', errorKind: 'timed_out' })
    if (cancelled || turn?.stopReason === 'cancelled') return end({ status: 'cancelled', summary: text.trim() })
    if (turn?.stopReason === 'refusal') return end({ summary: text.trim(), error: 'agy refused the task.', errorKind: 'agent_error' })
    if (!text.trim()) return end({ error: 'agy ended its turn without an answer.', errorKind: 'agent_error' })
    return end({ status: 'completed', summary: text.trim() })
  } catch (error) {
    if (cancelled) return end({ status: 'cancelled', summary: text.trim() })
    if (timedOut) return end({ summary: text.trim(), error: 'The task timed out.', errorKind: 'timed_out' })
    return end({ error: messageOf(error), errorKind: 'agent_error' })
  } finally {
    clearTimeout(deadline)
    clearTimeout(cancelTimer)
    input.signal?.removeEventListener('abort', onAbort)
    rpc.close(new Error('the turn ended'))
    child.stdin.end()
    killGroup('SIGTERM')
    const kill = setTimeout(() => killGroup('SIGKILL'), EXIT_GRACE_MS)
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, EXIT_GRACE_MS + 500))])
    clearTimeout(kill)
  }
}

/**
 * What the agent offers, spending no prompt: its models and its thinking levels, from a session it then closes.
 * @param {{ argv: string[], cwd: string, env?: Record<string, string | undefined>, clientVersion?: string }} input
 * @returns {Promise<{ models: { id: string, name: string }[], currentModel: string | null, efforts: string[] } | { error: string }>}
 */
export async function probe(input) {
  const [command = '', ...args] = input.argv
  const child = spawn(command, args, { cwd: input.cwd, env: input.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  let stderr = ''
  const rpc = peer({ write: (line) => void (child.stdin.writable && child.stdin.write(line)) })
  child.on('error', (error) => rpc.close(error))
  child.once('exit', (code) => rpc.close(new Error(`agy exited (code ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-2).join(' ')}` : ''}`)))
  child.stdout.setEncoding('utf8').on('data', (chunk) => rpc.feed(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk) => void (stderr = (stderr + chunk).slice(-STDERR_KEEP)))
  child.stdin.on('error', () => {})
  const timer = setTimeout(() => rpc.close(new Error('agy did not answer within 30 s')), 30_000)
  try {
    await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'spider-orchestrator', version: input.clientVersion ?? '0' } })
    const session = await rpc.request('session/new', { cwd: input.cwd, mcpServers: [] })
    const models = (Array.isArray(session?.models?.availableModels) ? session.models.availableModels : [])
      .filter((/** @type {any} */ model) => typeof model?.modelId === 'string')
      .map((/** @type {any} */ model) => ({ id: model.modelId, name: String(model.name ?? model.modelId) }))
    const thought = (Array.isArray(session?.configOptions) ? session.configOptions : []).find((/** @type {any} */ option) => option?.id === 'thought_level')
    const efforts = (Array.isArray(thought?.options) ? thought.options : []).map((/** @type {any} */ option) => option?.value).filter((/** @type {unknown} */ value) => typeof value === 'string')
    return { models, currentModel: typeof session?.models?.currentModelId === 'string' ? session.models.currentModelId : null, efforts }
  } catch (error) {
    return { error: messageOf(error) }
  } finally {
    clearTimeout(timer)
    rpc.close(new Error('probe ended'))
    child.stdin.end()
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
}
