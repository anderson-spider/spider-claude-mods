import { expect, test } from 'claude-code/testing'
import { TASK_CHARS } from '../hooks/effort'
import type { Choice } from '../hooks/effort'
import type { EvalBrief } from '../hooks/eval-briefs'
import { DEFAULT_ROUNDS, evalArgs, formatEval, MAX_ROUNDS, rated } from '../hooks/evaluate'

const brief = (patch: Partial<EvalBrief> = {}): EvalBrief => ({ id: 'b', split: 'dev', task: 'Find the router.', expected: 1, why: 'fixture', ...patch })
const choice = (patch: Partial<Choice> = {}): Choice => ({ effort: 'medium', level: 1, top: 1, jevReason: null, jevMs: 1, jevTokens: { input: 1_000_000, output: 9 }, headLevel: 1, fullLevel: null, ...patch })

test("an assessment is a hit, over or under against the expected level; a failure or a long brief without the full brief's level is counted apart", () => {
  expect(rated(brief(), choice())).toEqual({ id: 'b', verdict: 'hit', level: 1, head: 1, full: null, reason: null, costUsd: 0.042 })
  expect(rated(brief(), choice({ level: 2 })).verdict).toBe('over')
  expect(rated(brief(), choice({ level: 0 })).verdict).toBe('under')
  expect(rated(brief(), choice({ effort: null, level: null, jevReason: 'no-key', jevTokens: null }))).toMatchObject({ verdict: 'failed', reason: 'no-key', costUsd: 0 })
  const long = brief({ task: 'x'.repeat(TASK_CHARS + 1) })
  expect(rated(long, choice()).verdict).toBe('partial')
  expect(rated(long, choice({ level: 2, fullLevel: 2 })).verdict).toBe('over')
})

test('the arguments take rounds from 1 to 5 and a split, in any order, and refuse anything else', () => {
  expect([DEFAULT_ROUNDS, MAX_ROUNDS]).toEqual([3, 5])
  expect(evalArgs('')).toEqual({ rounds: 3, split: null })
  expect(evalArgs(' holdout 2 ')).toEqual({ rounds: 2, split: 'holdout' })
  expect(evalArgs('dev')).toEqual({ rounds: 3, split: 'dev' })
  for (const bad of ['0', '6', 'all', '2 3x', '-1']) expect(evalArgs(bad)).toEqual({ error: 'usage: /subagent-effort-eval [1-5] [dev|holdout]' })
})

test('the table shows each round per brief, marks a decision that varied, and counts verdicts per split with the Jev cost', () => {
  const briefs = [brief({ id: 'a' }), brief({ id: 'h', split: 'holdout', expected: 0 })]
  const rounds = [
    [rated(briefs[0]!, choice()), rated(briefs[1]!, choice({ level: 0, headLevel: 0 }))],
    [rated(briefs[0]!, choice({ level: 2, headLevel: 1, fullLevel: 2 })), rated(briefs[1]!, choice({ effort: null, level: null, jevReason: 'timeout', jevTokens: null }))],
  ]
  expect(formatEval(briefs, rounds).split('\n')).toEqual([
    '2 briefs × 2 rounds; levels 0-3 are low, medium, high, xhigh; each round shows decided(head/full).',
    'a [dev] expected 1: 1(1/-) 2(1/2) varies',
    'h [holdout] expected 0: 0(0/-) failed:timeout varies',
    'dev: 1 hit, 1 over, 0 under, 0 failed, 0 partial.',
    'holdout: 1 hit, 0 over, 0 under, 1 failed, 0 partial.',
    'Jev cost about $0.13 (estimated).',
  ])
})
