import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bucketsFor, gateOf, parseUsage, resetText, type Bucket } from '../cli/quota.ts'
import { USAGE_JSON } from './fake-agy.ts'

const buckets = parseUsage(JSON.stringify(USAGE_JSON)) as Bucket[]
const ids = (list: Bucket[]) => list.map(bucket => bucket.id).sort()

test('parseUsage reads every enabled bucket with its window, fraction and reset', () => {
  assert.equal(buckets.length, 5)
  assert.deepEqual(buckets.find(bucket => bucket.id === 'gemini-5h'), { id: 'gemini-5h', label: 'Gemini Models · 5-hour', window: '5h', remaining: 0.25, resetsAt: '2026-11-18T14:00:00Z' })
})

test('parseUsage refuses what is not a successful /usage answer', () => {
  assert.deepEqual(parseUsage('not json'), { error: 'agy /usage did not answer JSON.' })
  assert.deepEqual(parseUsage(JSON.stringify({ status: 'ERROR' })), { error: 'agy /usage did not succeed.' })
  assert.deepEqual(parseUsage(JSON.stringify({ status: 'SUCCESS', command: { name: 'usage', data: { groups: [] } } })), { error: 'agy /usage listed no quota.' })
})

test('parseUsage skips disabled and malformed buckets', () => {
  const answer = { status: 'SUCCESS', command: { name: 'usage', data: { groups: [{ name: 'G', buckets: [{ id: 'a', disabled: true, remaining_fraction: 1 }, { id: 'b' }, { id: 'c', window: '5h', remaining_fraction: 2 }] }] } } }
  assert.deepEqual(parseUsage(JSON.stringify(answer)), [{ id: 'c', label: 'G · 5-hour', window: '5h', remaining: 1 }])
})

test('bucketsFor picks the shared Gemini buckets, the family ones, or the third-party pool', () => {
  assert.deepEqual(ids(bucketsFor(buckets, undefined)), ['gemini-5h', 'gemini-weekly'])
  assert.deepEqual(ids(bucketsFor(buckets, 'gemini-3.8-flash-low')), ['gemini-5h', 'gemini-weekly'])
  assert.deepEqual(ids(bucketsFor(buckets, 'gemini-4-argon-high')), ['gemini-5h', 'gemini-argon-wtu-weekly', 'gemini-weekly'])
  assert.deepEqual(ids(bucketsFor(buckets, 'claude-opus-5-5-high')), ['3p-5h', '3p-weekly'])
})

test('gateOf warns at 30% left and refuses at 10%, on the lowest bucket', () => {
  assert.equal(gateOf(bucketsFor(buckets, undefined)).verdict, 'warn')
  assert.equal(gateOf(bucketsFor(buckets, 'gemini-4-argon-high')).verdict, 'refuse')
  assert.equal(gateOf(bucketsFor(buckets, 'gemini-4-argon-high')).lowest?.id, 'gemini-argon-wtu-weekly')
  assert.deepEqual(gateOf([]), { verdict: 'ok' })
})

test('resetText says how long until the reset and when, in UTC', () => {
  const now = Date.parse('2026-11-18T11:55:00Z')
  assert.equal(resetText('2026-11-18T14:00:00Z', now), 'resets in about 2 h 5 min (at 2026-11-18 14:00 UTC)')
  assert.equal(resetText('2026-11-18T12:00:00Z', now), 'resets in about 5 min (at 2026-11-18 12:00 UTC)')
  assert.equal(resetText('2026-11-25T14:00:00Z', now), 'resets in about 7 d 2 h (at 2026-11-25 14:00 UTC)')
  assert.equal(resetText(undefined, now), '')
})
