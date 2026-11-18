// Why a task failed, in one class, with agy's text redacted: its errors name the Google Cloud project and region, so
// only the class, the quota's reset time and a redacted first line are ever shown.
import { firstLine } from './agy.ts'
import type { TurnResult } from './acp.ts'

export type Reason = 'quota exhausted' | 'signed out' | 'timed out' | 'idle' | 'model unavailable' | 'resume failed' | 'cancelled' | 'no answer' | 'agy error'

// When an exhausted quota comes back, as a Google API error renders it (google.rpc.ErrorInfo metadata or RetryInfo),
// whether Go-printed (`quotaResetDelay:2h5m0s`) or JSON (`"quotaResetDelay":"7500s"`).
const RESET_TIMESTAMP = /\bquotaResetTimeStamp"?\s*[:=]\s*"?(\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d))/
const DURATION = '((?:\\d+(?:\\.\\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)'
const RESET_DELAY = new RegExp(`\\bquotaResetDelay"?\\s*[:=]\\s*"?${DURATION}`)
const RETRY_DELAY = new RegExp(`\\bretryDelay"?\\s*[:=]\\s*"?${DURATION}`)
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/g
const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, μs: 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

/** A Go duration (`2h5m0s`, `7500s`, `1.5s`) in milliseconds. */
export function durationMs(text: string): number {
  let ms = 0
  for (const [, value, unit] of text.matchAll(DURATION_PART)) ms += Number(value) * (UNIT_MS[unit ?? ''] ?? 0)
  return ms
}

/** When an exhausted quota resets, from agy's error texts; undefined when they do not say. */
export function quotaResetOf(text: string, endedAt: number): number | undefined {
  const stamp = RESET_TIMESTAMP.exec(text)?.[1]
  const at = stamp ? Date.parse(stamp) : Number.NaN
  if (!Number.isNaN(at)) return at
  const delay = (RESET_DELAY.exec(text) ?? RETRY_DELAY.exec(text))?.[1]
  return delay ? endedAt + durationMs(delay) : undefined
}

export function resetSentence(resetAt: number, endedAt: number): string {
  const minutes = Math.round(Math.max(0, resetAt - endedAt) / 60_000)
  const wait = minutes < 1 ? 'in less than a minute' : minutes < 60 ? `in about ${minutes} min` : `in about ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
  return `The quota resets ${wait} (at ${new Date(resetAt).toISOString().slice(0, 16).replace('T', ' ')} UTC).`
}

const QUOTA = /\b(RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED)\b|\bquota\b.*\b(exceeded|exhausted)\b|\b(?:status|code|http)\W{0,3}429\b|\b429 Too Many Requests\b/i
const AUTH = /\b(UNAUTHENTICATED|PERMISSION_DENIED|not (?:signed|logged) in|sign in|login required|auth(?:entication)? (?:required|failed))\b/i

export interface Failure {
  reason: Reason
  /** One line for the person: the class, a redacted reason, and when the quota resets. */
  message: string
}

/** The failure of a turn that did not complete; `endedAt` dates a quota reset given as a delay. */
export function classify(turn: TurnResult, endedAt: number): Failure {
  const texts = [turn.error ?? '', turn.stderr].join('\n')
  // When agy exited, its reason is in stderr, not in the exit line.
  const exited = /^agy exited\b/.test(turn.error ?? '')
  const said = exited ? firstLine(turn.stderr) || firstLine(turn.error) : firstLine(turn.error) || firstLine(turn.stderr)
  const say = (reason: Reason, extra = '') => ({ reason, message: `agy failed (${reason})${said ? `: ${said}` : ''}${extra}` })
  if (turn.status === 'cancelled') return { reason: 'cancelled', message: 'The task was cancelled.' }
  if (turn.errorKind === 'timed_out') return { reason: 'timed out', message: 'agy failed (timed out): the task reached its time limit.' }
  if (turn.errorKind === 'idle') return { reason: 'idle', message: 'agy failed (idle): it sent nothing for too long.' }
  if (QUOTA.test(texts)) {
    const resetAt = quotaResetOf(texts, endedAt)
    return say('quota exhausted', resetAt === undefined ? '' : ` ${resetSentence(resetAt, endedAt)}`)
  }
  if (AUTH.test(texts)) return say('signed out', ' Run agy once to sign in.')
  if (turn.errorKind === 'model_unavailable') return say('model unavailable', ' antigravity-delegate models lists the ids.')
  if (turn.errorKind === 'resume_failed') return say('resume failed', ' Start a new task instead.')
  if (turn.errorKind === 'no_answer') return { reason: 'no answer', message: 'agy ended its turn without an answer.' }
  return say('agy error')
}
