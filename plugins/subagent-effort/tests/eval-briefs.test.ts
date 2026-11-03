import { expect, test } from 'claude-code/testing'
import { EFFORTS, TASK_CHARS, FULL_CHARS } from '../hooks/effort'
import { EVAL_BRIEFS } from '../hooks/eval-briefs'

test('every evaluation brief has a unique id, a split, an expected level of the scale and a reason, within what Jev reads', () => {
  expect(new Set(EVAL_BRIEFS.map(b => b.id)).size).toBe(EVAL_BRIEFS.length)
  for (const b of EVAL_BRIEFS) {
    expect(b.id.startsWith(b.split === 'dev' ? 'd-' : 'h-')).toBe(true)
    expect(b.expected >= 0 && b.expected < EFFORTS.length).toBe(true)
    expect(b.why.length).toBeGreaterThan(0)
    expect(b.task.length).toBeLessThanOrEqual(FULL_CHARS)
  }
})

test('both splits cover every level, and each has long briefs that only the full-brief call reads past the head', () => {
  for (const split of ['dev', 'holdout'] as const) {
    const briefs = EVAL_BRIEFS.filter(b => b.split === split)
    expect([...new Set(briefs.map(b => b.expected))].sort()).toEqual([0, 1, 2, 3])
    expect(briefs.filter(b => b.task.length > TASK_CHARS).length).toBeGreaterThanOrEqual(2)
  }
})
