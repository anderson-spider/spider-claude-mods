import type { Reason, RunResult } from './model'

// Reads what `agy -p --output-format=stream-json` prints: one JSON event per line on stdout. The ones read here:
//   {"event":"init","conversation_id":"…","init":{"model":"…"}}                   the conversation a follow-up continues
//   {"event":"result","result":{"status":"SUCCESS"|"ERROR","response":"…","error":"…","finished_reason":"…"}}
// and, on an API failure (exit code 3), one line on stderr:
//   AGY_ERROR: {"short_error":"…","status":"RESOURCE_EXHAUSTED","retryable":true,"error_id":"…"}
// `short_error` names the Google Cloud project and region, so it is never shown. A non-JSON line is ignored.

type Event = {
  event?: unknown
  result?: { conversation_id?: unknown; status?: unknown; response?: unknown; error?: unknown; finished_reason?: unknown }
}

type AgyError = { status?: unknown; error_id?: unknown }

/** Text that may name a Google Cloud project or region, with those parts blanked. */
export const redact = (text: string) => text.replace(/\b(projects|locations)\/[^/\s"']+/g, '$1/…').replace(/\bproject[ _-]?(?:id)?[:=]\s*\S+/gi, 'project …')

// The most stderr kept for an error text: its tail says why the process stopped.
const STDERR_TAIL = 1000

function agyErrorOf(stderr: string): AgyError | undefined {
  const found = /^AGY_ERROR:\s*(\{.*\})\s*$/m.exec(stderr)
  if (!found) return undefined
  try {
    return JSON.parse(found[1]!) as AgyError
  } catch {
    return undefined
  }
}

/** Folds the end of one run's events (its `result` line), its stderr and its exit status into its result. */
export function readRun(stdout: string, stderr: string, exit: { code: number | null; signal: string | null }): RunResult {
  const result: RunResult = {}
  let status: unknown
  let error: string | undefined
  let finished: unknown
  for (const text of stdout.split('\n')) {
    if (!text.trim()) continue
    let event: Event
    try {
      event = JSON.parse(text) as Event
    } catch {
      continue
    }
    if (event.event === 'result' && event.result) {
      const r = event.result
      if (typeof r.conversation_id === 'string' && r.conversation_id) result.conversationId = r.conversation_id
      status = r.status
      if (typeof r.response === 'string') result.message = r.response
      if (typeof r.error === 'string' && r.error.trim()) error = r.error.trim()
      finished = r.finished_reason
    }
  }
  if (exit.code === 0 && status === 'SUCCESS' && result.message !== undefined) return result
  const agy = agyErrorOf(stderr)
  const reason = reasonOf(exit, agy, finished)
  const said = error ?? (agy ? `${String(agy.status ?? 'error')}${typeof agy.error_id === 'string' ? ` (error id ${agy.error_id})` : ''}` : undefined)
  const why = said ?? (stderr.replace(/^AGY_ERROR:.*$/m, '').trim().slice(-STDERR_TAIL) || (exit.signal ? `stopped by ${exit.signal}` : `exit code ${String(exit.code)}`))
  return { ...result, reason, error: `agy failed (${reason}): ${redact(why)}`, ...(reason === 'timed out' ? { timedOut: true } : {}) }
}

/** Why a run failed: quota first (it says what to do), then agy's own finish reason, then the exit code. */
function reasonOf(exit: { code: number | null; signal: string | null }, agy: AgyError | undefined, finished: unknown): Reason {
  if (agy?.status === 'RESOURCE_EXHAUSTED') return 'quota exhausted'
  if (finished === 'print_timeout') return 'timed out'
  if (finished === 'interrupted' || exit.signal) return 'interrupted'
  if (exit.code === 1) return 'local error'
  return 'agy error'
}

/**
 * The conversation id in the start of a run's events, once `init` arrived. Read by pattern, not as JSON: the `init`
 * line lists every tool agy has and can run past the bytes read, while its id comes first.
 */
export function conversationOf(head: string): string | undefined {
  return /"event":"init","conversation_id":"([^"]+)"/.exec(head)?.[1]
}

/** The model agy picked, from the same `init` line: the one a run without `--model` used. */
export function modelOf(head: string): string | undefined {
  return /"event":"init",[^\n]*?"init":\{"model":"([^"]+)"/.exec(head)?.[1]
}
