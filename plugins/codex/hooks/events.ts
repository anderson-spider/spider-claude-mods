import type { Exit, RunResult } from './model'

// Reads what `codex exec --json` prints: one JSON event per line on stdout. The ones read here:
//   {"type":"thread.started","thread_id":"…"}                         the session id a follow-up resumes
//   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}  an answer; the last one is the reply
//   {"type":"turn.failed","error":{"message":"…"}}                     the turn's failure
//   {"type":"error","message":"…"}                                     an error the run reports; a run that answers
//                                                                       after one (a reconnect) still succeeded
// A non-JSON line (a notice Codex prints) is ignored.

type Event = {
  type?: unknown
  thread_id?: unknown
  message?: unknown
  item?: { type?: unknown; text?: unknown }
  error?: { message?: unknown }
}

// The most stderr kept for an error text: its tail says why the process stopped.
const STDERR_TAIL = 2000

/** Folds the events of one run into its result, as the pieces of its output arrive. */
export function eventReader() {
  const result: RunResult = {}
  let pending = ''
  let stderr = ''
  let failed: string | undefined
  let lastError: string | undefined

  function line(text: string) {
    let event: Event
    try {
      event = JSON.parse(text) as Event
    } catch {
      return
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') result.threadId = event.thread_id
    else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
      result.message = event.item.text
    } else if (event.type === 'turn.failed' && typeof event.error?.message === 'string') failed = event.error.message
    else if (event.type === 'error' && typeof event.message === 'string') lastError = event.message
  }

  return {
    /** The session id, once `thread.started` arrived. */
    get threadId() {
      return result.threadId
    },
    /** One piece of stdout or stderr, cut wherever the child's write ended. */
    push(stream: 'stdout' | 'stderr', text: string) {
      if (stream === 'stderr') {
        stderr = (stderr + text).slice(-STDERR_TAIL)
        return
      }
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const each of lines) if (each.trim()) line(each)
    },
    /**
     * The result once the child ended. A failed turn is an error; so is a run that ended without an answer or with a
     * failed exit, explained by its last error event, else the tail of its stderr.
     */
    end(exit: Exit): RunResult {
      if (pending.trim()) line(pending)
      pending = ''
      if (failed) result.error = failed
      else if (result.message === undefined || exit.code !== 0) {
        const why = lastError ?? (stderr.trim() || (exit.signal ? `stopped by ${exit.signal}` : `exit code ${String(exit.code)}`))
        result.error = `Codex ended without an answer: ${why}`
      }
      return result
    },
  }
}
