import { expect, test } from 'claude-code/testing'
import { durationMs, quotaResetOf, readRun } from '../hooks/events'
import { agyError, failed } from './fakes'

const ENDED = Date.UTC(2026, 10, 17, 13, 25)
const exit3 = { code: 3, signal: null }

test('a Go or JSON duration reads in milliseconds', () => {
  expect(durationMs('2h5m0s')).toBe(7_500_000)
  expect(durationMs('7500s')).toBe(7_500_000)
  expect(durationMs('1.5s')).toBe(1_500)
  expect(durationMs('250ms')).toBe(250)
})

test('an exhausted quota says when it resets, from the reset time or the delay, and never shows the project or region', () => {
  const go = 'Error 429, Message: quota for projects/acme-prod-42/locations/us-central1, Status: RESOURCE_EXHAUSTED [reason:QUOTA_EXHAUSTED quotaResetDelay:2h5m0s]'
  const run = readRun(failed('Quota exhausted for projects/acme-prod-42'), agyError('RESOURCE_EXHAUSTED', go), exit3, ENDED)
  expect(run.reason).toBe('quota exhausted')
  expect(run.error).toMatch(/^agy failed \(quota exhausted\): Quota exhausted for projects\/… The quota resets in about 2 h 5 min \(at 2026-11-17 15:30 UTC\)\.$/)
  expect(run.error).not.toMatch(/acme-prod-42|us-central1/)

  const stamp = readRun(failed('quota'), agyError('RESOURCE_EXHAUSTED', '"quotaResetTimeStamp": "2026-11-17T13:45:00Z"'), exit3, ENDED)
  expect(stamp.error).toMatch(/ The quota resets in about 20 min \(at 2026-11-17 13:45 UTC\)\.$/)

  const retry = readRun(failed('rate limited: RESOURCE_EXHAUSTED retryDelay:30s'), '', exit3, ENDED)
  expect(retry.reason).toBe('quota exhausted')
  expect(retry.error).toMatch(/ The quota resets in about 1 min \(at 2026-11-17 13:25 UTC\)\.$/)

  expect(quotaResetOf('no reset here', ENDED)).toBeUndefined()
  const plain = readRun(failed('Quota exhausted'), agyError('RESOURCE_EXHAUSTED', 'quota'), exit3, ENDED)
  expect(plain.error).toBe('agy failed (quota exhausted): Quota exhausted')
})

test('a review run keeps its structured output', () => {
  const stdout = `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '{}', conversation_id: 'c', structured_output: { findings: [] } } })}\n`
  expect(readRun(stdout, '', { code: 0, signal: null })).toEqual({ conversationId: 'c', message: '{}', structured: { findings: [] } })
})
