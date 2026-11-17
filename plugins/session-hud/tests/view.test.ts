import { expect, test } from 'claude-code/testing'
import type { SessionHudCard } from '../types'
import { cacheCells, contextOf, headCells, modelName, shownLimits, turnCells, workspaceCells } from '../hooks/view'
import type { Row } from '../hooks/view'

const now = Date.parse('2026-10-13T12:00:00Z')
const full: SessionHudCard = {
  model: 'claude-opus-5-5', effort: 'medium', context: { tokens: 200_000, window: 1_000_000, percent: 20 }, cache: 95,
  limits: [{ kind: 'seven_day', percentUsed: 60 }, { kind: 'five_hour', percentUsed: 74 }],
  lastTurnMs: 5_000, edits: 2, errors: 1, turns: 0, history: [],
}
const text = (row: Row) => row.map(s => s.text).join('')

test('the context is measured against the window the host compacts at, and its tokens are shown', () => {
  expect(contextOf({ ...full, context: { tokens: 440_000, window: 1_000_000, percent: 44 }, contextWindow: 500_000 })).toEqual({ percent: 88, used: 440_000, window: 500_000 })
  expect(contextOf({ ...full, context: { tokens: 520_000, window: 1_000_000, percent: 52 }, contextWindow: 500_000 })?.percent).toBe(104)
  expect(contextOf({ ...full, context: { window: 1_000_000, percent: 44 } })).toEqual({ percent: 44 })
})

test('while a turn runs the dot turns yellow and the turn time counts; between turns it is green with no time', () => {
  const running = headCells({ ...full, turnStartedAt: now - 12_000 }, now, true)
  expect(running[0]).toEqual({ text: '● ', style: 'warning' })
  expect(text(running)).toBe('● Opus 5.5 · medium · working 12s')
  const idle = headCells({ ...full, turnStartedAt: now - 12_000 }, now, false)
  expect(idle[0]).toEqual({ text: '● ', style: 'success' })
  expect(text(idle)).toBe('● Opus 5.5 · medium')
})

test('what the host has not reported is left out instead of drawn as zero', () => {
  const bare: SessionHudCard = { limits: [], edits: 0, errors: 0, turns: 0, history: [] }
  expect([headCells(bare, now, false), cacheCells(bare)]).toEqual([[], []])
  expect(contextOf(bare)).toBeUndefined()
  expect(text(turnCells(bare))).toBe('0 edits · 0 errors')
  expect(text(turnCells(full))).toBe('last turn 5s · 2 edits · 1 error')
})

test('only Claude model ids reach the screen, named by family and version', () => {
  expect([modelName('claude-opus-5-5'), modelName('claude-haiku-4-5-20251001'), modelName('sonnet'), modelName(undefined)])
    .toEqual(['Opus 5.5', 'Haiku 4.5', 'Sonnet', undefined])
  for (const hostile of ['gpt-6-astra', '/Users/me', 'claude-opus-5-5\u001b[31m']) expect(modelName(hostile)).toBe('?')
  expect(text(headCells({ ...full, model: '/Users/me/secret', effort: 'loud\u001b' }, now, false))).toBe('● ?')
})

test('a spend limit and malformed figures never reach the screen as numbers', () => {
  const card: SessionHudCard = { ...full, cache: Number.NaN, edits: 1.5, errors: Number.NaN, limits: [{ kind: 'spend_limit', percentUsed: 30 }, ...full.limits] }
  expect(cacheCells(card)).toEqual([])
  expect(text(turnCells(card))).toBe('last turn 5s · 0 edits · 0 errors')
  expect(shownLimits(card).map(limit => limit.kind)).toEqual(['five_hour', 'seven_day'])
})

test('the workspace names the repository and its folder, the branch and a worktree; nothing before the first reading', () => {
  expect(workspaceCells(full)).toEqual([])
  expect(text(workspaceCells({ ...full, workspace: { repo: 'mods' } }))).toBe('mods')
  const linked = workspaceCells({ ...full, workspace: { repo: 'mods', sub: 'plugins', branch: 'me/feature', worktree: true } })
  expect(text(linked)).toBe('mods/plugins · ⎇ me/feature · worktree')
  expect(linked[0]).toEqual({ text: 'mods/plugins', style: 'sent' })
  expect(linked[2]).toEqual({ text: '⎇ me/feature', style: 'success' })
})
