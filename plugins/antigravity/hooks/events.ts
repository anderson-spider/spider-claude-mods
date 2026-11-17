import type { Reason, RunResult } from './model'

// Reads what `agy -p --output-format=stream-json` prints: one JSON event per line on stdout. The ones read here:
//   {"event":"init","conversation_id":"…","init":{"model":"…"}}                   the conversation a follow-up continues
//   {"event":"result","result":{"status":"SUCCESS"|"ERROR","response":"…","error":"…","finished_reason":"…","structured_output":{…}}}
// and, on an API failure (exit code 3), one line on stderr:
//   AGY_ERROR: {"short_error":"…","status":"RESOURCE_EXHAUSTED","retryable":true,"error_id":"…"}
// `short_error` names the Google Cloud project and region, so it is never shown; only the quota's reset time is read
// from it. `structured_output` is there when the run passed `--json-schema` (a review). A non-JSON line is ignored.

type Event = {
  event?: unknown
  result?: { conversation_id?: unknown; status?: unknown; response?: unknown; error?: unknown; finished_reason?: unknown; structured_output?: unknown }
}

type AgyError = { status?: unknown; error_id?: unknown; short_error?: unknown }

/** Text that may name a Google Cloud project or region, with those parts blanked. */
export const redact = (text: string) => text.replace(/\b(projects|locations)\/[^/\s"']+/g, '$1/…').replace(/\bproject[ _-]?(?:id)?[:=]\s*\S+/gi, 'project …')

// The most stderr kept for an error text: its tail says why the process stopped.
const STDERR_TAIL = 1000

// When an exhausted quota comes back, as a Google API error renders it (google.rpc.ErrorInfo metadata, or RetryInfo for
// a plain rate limit), whether as Go prints the details (`quotaResetDelay:2h5m0s`) or as JSON
// (`"quotaResetDelay":"7500s"`). Only these values are read: the text around them can name the project and region.
const RESET_TIMESTAMP = /\bquotaResetTimeStamp"?\s*[:=]\s*"?(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/
const DURATION = '((?:\\d+(?:\\.\\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)'
const RESET_DELAY = new RegExp(`\\bquotaResetDelay"?\\s*[:=]\\s*"?${DURATION}`)
const RETRY_DELAY = new RegExp(`\\bretryDelay"?\\s*[:=]\\s*"?${DURATION}`)
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g
const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, μs: 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

/** A Go duration (`2h5m0s`, `7500s`, `1.5s`) in milliseconds. */
export function durationMs(text: string): number {
  let ms = 0
  for (const [, value, unit] of text.matchAll(DURATION_PART)) ms += Number(value) * UNIT_MS[unit!]!
  return ms
}

/** When an exhausted quota resets, from the error texts of a run that ended at `endedAt`; undefined when they do not say. */
export function quotaResetOf(text: string, endedAt: number): number | undefined {
  const stamp = RESET_TIMESTAMP.exec(text)?.[1]
  const at = stamp ? Date.parse(stamp) : Number.NaN
  if (!Number.isNaN(at)) return at
  const delay = (RESET_DELAY.exec(text) ?? RETRY_DELAY.exec(text))?.[1]
  return delay ? endedAt + durationMs(delay) : undefined
}

/** The sentence a quota failure ends with: when the quota comes back, as a wait from the run's end and in UTC. */
export function resetText(resetAt: number, endedAt: number): string {
  const minutes = Math.round(Math.max(0, resetAt - endedAt) / 60_000)
  const wait = minutes < 1 ? 'in less than a minute' : minutes < 60 ? `in about ${minutes} min` : `in about ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  const at = new Date(resetAt).toISOString().slice(0, 16).replace('T', ' ')
  return `The quota resets ${wait} (at ${at} UTC).`
}

function agyErrorOf(stderr: string): AgyError | undefined {
  const found = /^AGY_ERROR:\s*(\{.*\})\s*$/m.exec(stderr)
  if (!found) return undefined
  try {
    return JSON.parse(found[1]!) as AgyError
  } catch {
    return undefined
  }
}

/**
 * Folds the end of one run's events (its `result` line), its stderr and its exit status into its result. `endedAt`,
 * when the run ended, dates the quota's reset when agy gives it as a delay.
 */
export function readRun(stdout: string, stderr: string, exit: { code: number | null; signal: string | null }, endedAt = Date.now()): RunResult {
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
      if (r.structured_output !== undefined) result.structured = r.structured_output
    }
  }
  if (exit.code === 0 && status === 'SUCCESS' && result.message !== undefined) return result
  const agy = agyErrorOf(stderr)
  const reason = reasonOf(exit, agy, finished, error)
  const said = error ?? (agy ? `${String(agy.status ?? 'error')}${typeof agy.error_id === 'string' ? ` (error id ${agy.error_id})` : ''}` : undefined)
  const why = said ?? (stderr.replace(/^AGY_ERROR:.*$/m, '').trim().slice(-STDERR_TAIL) || (exit.signal ? `stopped by ${exit.signal}` : `exit code ${String(exit.code)}`))
  // short_error is read unescaped (its JSON quotes would hide a JSON-shaped reset time), never shown.
  const errorTexts = [typeof agy?.short_error === 'string' ? agy.short_error : '', stderr, error ?? ''].join('\n')
  const resetAt = reason === 'quota exhausted' ? quotaResetOf(errorTexts, endedAt) : undefined
  const reset = resetAt === undefined ? '' : ` ${resetText(resetAt, endedAt)}`
  return { ...result, reason, error: `agy failed (${reason}): ${redact(why)}${reset}`, ...(reason === 'timed out' ? { timedOut: true } : {}) }
}

/** Why a run failed: quota first (it says what to do), then agy's own finish reason, then the exit code. */
function reasonOf(exit: { code: number | null; signal: string | null }, agy: AgyError | undefined, finished: unknown, error: string | undefined): Reason {
  if (agy?.status === 'RESOURCE_EXHAUSTED' || /\b(?:RESOURCE|QUOTA)_EXHAUSTED\b/.test(error ?? '')) return 'quota exhausted'
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
