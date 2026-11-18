// One task's turn on `agy acp`: spawn it in its own process group, start or resume a session, set the model and
// effort, send the prompt, answer each permission request through `decide`, and stop it, whatever happens.
// Measured on agy 1.5.11: the session stays in agy's `default` mode (it rejects `yolo` and `auto_edit`) and asks the
// client before every read, edit and command; it ends its turn with no text at each refusal, so it is prompted on;
// `session/resume` keeps the conversation's memory without replaying it.
import { spawn } from 'node:child_process'
import { RpcError, peer } from './jsonrpc.ts'
import { outcomeOf, type Decision } from './policy.ts'

// How long agy gets to end its turn after session/cancel, and to exit after SIGTERM, before SIGKILL.
const CANCEL_GRACE_MS = 5_000
const EXIT_GRACE_MS = 2_000
const STDERR_KEEP = 8_000

/** Sent when a turn ended empty after a refusal: agy then goes on with the task. */
export const RETRY_PROMPT =
  'The client refused that action under its permission rules. Do not try it again, nor any other action of that kind: go on with what you can do, then answer, saying what you could not do.'
export const MAX_RETRIES = 4

export interface Refusal {
  kind: string
  title: string
  reason: string
}

export interface TurnInput {
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  /** An agy session to go on with, else a new one. */
  resumeSessionId?: string
  model?: string
  effort?: string
  decide: (toolCall: any) => Decision
  /** How long the turn may run in all, and with no message from agy. */
  deadlineMs: number
  idleMs: number
  signal?: AbortSignal
  onUpdate?: (update: { sessionId?: string; executedModel?: string | null; progress?: string }) => void
  clientVersion: string
}

export type ErrorKind = 'model_unavailable' | 'timed_out' | 'idle' | 'agent_error' | 'resume_failed'

export interface TurnResult {
  status: 'completed' | 'failed' | 'cancelled'
  /** agy's answer; on a failure, whatever it wrote first. */
  answer: string
  error?: string
  errorKind?: ErrorKind
  sessionId?: string
  executedModel: string | null
  refused: Refusal[]
  /** The end of agy's stderr, for classifying a failure (never shown as is). */
  stderr: string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2_000)

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const [command = '', ...args] = input.argv
  const child = spawn(command, args, { cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  let stderr = ''
  let exited = false
  const refused: Refusal[] = []
  let text = ''
  let collecting = false
  let sessionId: string | undefined
  let executedModel: string | null = null
  let stop: 'timed_out' | 'idle' | 'cancelled' | undefined

  const rpc = peer({
    write: line => void (child.stdin.writable && child.stdin.write(line)),
    async onRequest(method, params) {
      touch()
      if (method === 'session/request_permission') {
        const toolCall = params?.toolCall
        const decision = input.decide(toolCall)
        if (!decision.allow) {
          refused.push({ kind: typeof toolCall?.kind === 'string' ? toolCall.kind : 'other', title: String(toolCall?.title ?? 'an action').slice(0, 200), reason: decision.reason ?? 'refused' })
        }
        return outcomeOf(decision.allow, params?.options)
      }
      // The client offers no file system or terminal: the agent uses its own tools, behind the requests above.
      throw new RpcError(-32601, `${method} is not offered by this client`)
    },
    onNotification(method, params) {
      touch()
      const update = method === 'session/update' ? params?.update : undefined
      if (!collecting || !update) return
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') text += String(update.content.text ?? '')
      else if (update.sessionUpdate === 'tool_call' && typeof update.title === 'string') input.onUpdate?.({ progress: update.title.slice(0, 200) })
    },
  })
  const stopped = new Promise(resolve => child.once('exit', resolve))
  child.on('error', error => rpc.close(error))
  child.once('exit', (code, signal) => {
    exited = true
    rpc.close(new Error(`agy exited (${signal ?? `code ${code}`})`))
  })
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => rpc.feed(chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr = (stderr + chunk).slice(-STDERR_KEEP)))
  child.stdin.on('error', () => {})

  const killGroup = (signal: NodeJS.Signals) => {
    if (exited || child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
  }
  let cancelTimer: NodeJS.Timeout | undefined
  const cancelTurn = (why: 'timed_out' | 'idle' | 'cancelled') => {
    stop ??= why
    if (sessionId) rpc.notify('session/cancel', { sessionId })
    cancelTimer ??= setTimeout(() => {
      killGroup('SIGKILL')
      rpc.close(new Error('agy did not stop'))
    }, CANCEL_GRACE_MS)
  }
  const deadline = setTimeout(() => cancelTurn('timed_out'), input.deadlineMs)
  let idle: NodeJS.Timeout | undefined
  function touch() {
    clearTimeout(idle)
    idle = setTimeout(() => cancelTurn('idle'), input.idleMs)
  }
  touch()
  const onAbort = () => cancelTurn('cancelled')
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted) onAbort()

  const end = (result: Partial<TurnResult>): TurnResult => ({ status: 'failed', answer: text.trim(), sessionId, executedModel, refused, stderr, ...result })
  const stopped_ = (): TurnResult | undefined => {
    if (stop === 'cancelled') return end({ status: 'cancelled' })
    if (stop === 'timed_out') return end({ error: 'The task reached its time limit.', errorKind: 'timed_out' })
    if (stop === 'idle') return end({ error: 'agy sent nothing for too long.', errorKind: 'idle' })
    return undefined
  }
  try {
    await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'spider-antigravity', version: input.clientVersion },
    })
    let session: any
    if (input.resumeSessionId) {
      try {
        session = { sessionId: input.resumeSessionId, ...(await rpc.request('session/resume', { sessionId: input.resumeSessionId, cwd: input.cwd, mcpServers: [] })) }
      } catch (error) {
        return stopped_() ?? end({ error: `agy could not resume its session: ${messageOf(error)}`, errorKind: 'resume_failed' })
      }
    } else session = await rpc.request('session/new', { cwd: input.cwd, mcpServers: [] })
    sessionId = typeof session?.sessionId === 'string' ? session.sessionId : undefined
    if (!sessionId) return end({ error: 'agy started no session.', errorKind: 'agent_error' })
    executedModel = typeof session?.models?.currentModelId === 'string' ? session.models.currentModelId : null
    input.onUpdate?.({ sessionId, executedModel })
    const early = stopped_()
    if (early) return early
    // agy's own mode stays `default`, which asks before every action; the task's mode is the client's answers.
    await rpc.request('session/set_mode', { sessionId, modeId: 'default' }).catch(() => undefined)
    if (input.model) {
      try {
        await rpc.request('session/set_model', { sessionId, modelId: input.model })
      } catch (error) {
        return stopped_() ?? end({ error: messageOf(error), errorKind: 'model_unavailable' })
      }
      executedModel = input.model
      input.onUpdate?.({ executedModel })
    }
    if (input.effort) {
      try {
        await rpc.request('session/set_config_option', { sessionId, configId: 'thought_level', value: input.effort })
      } catch (error) {
        return stopped_() ?? end({ error: `agy refused effort ${input.effort}: ${messageOf(error)}`, errorKind: 'model_unavailable' })
      }
    }
    const ready = stopped_()
    if (ready) return ready
    collecting = true
    let seen = refused.length
    let turn = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] })
    for (let retry = 0; retry < MAX_RETRIES && turn?.stopReason === 'end_turn' && !text.trim() && refused.length > seen && !stop; retry++) {
      seen = refused.length
      turn = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: RETRY_PROMPT }] })
    }
    const late = stopped_()
    if (late) return late
    if (turn?.stopReason === 'cancelled') return end({ status: 'cancelled' })
    if (turn?.stopReason === 'refusal') return end({ error: 'agy refused the task.', errorKind: 'agent_error' })
    if (!text.trim()) return end({ error: 'agy ended its turn without an answer.', errorKind: 'agent_error' })
    return end({ status: 'completed' })
  } catch (error) {
    return stopped_() ?? end({ error: messageOf(error), errorKind: 'agent_error' })
  } finally {
    clearTimeout(deadline)
    clearTimeout(idle)
    clearTimeout(cancelTimer)
    input.signal?.removeEventListener('abort', onAbort)
    rpc.close(new Error('the turn ended'))
    child.stdin.end()
    killGroup('SIGTERM')
    const kill = setTimeout(() => killGroup('SIGKILL'), EXIT_GRACE_MS)
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, EXIT_GRACE_MS + 500))])
    clearTimeout(kill)
  }
}
