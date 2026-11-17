import { expect, test } from 'claude-code/testing'
import { EMPTY, HISTORY, began, cacheUsed, compactedNow, completed, counted, located, measured, stepped, switched, timed, touchedCache, unseen, windowed } from '../hooks/card'

test('a workspace reading replaces the last, an unchanged one leaves the card as it was, and none clears it', () => {
  const card = located(EMPTY, { repo: 'mods', branch: 'main' })
  expect(card).toEqual({ ...EMPTY, workspace: { repo: 'mods', branch: 'main' } })
  expect(located(card, { repo: 'mods', branch: 'main' })).toBe(card)
  expect(located(card, { repo: 'mods', branch: 'dev' }).workspace).toEqual({ repo: 'mods', branch: 'dev' })
  expect(located(card, undefined)).toEqual(EMPTY)
})

test('a measurement keeps the context and the readable windows, and nothing of a cost', () => {
  const card = measured(EMPTY, { context: { tokens: 10, window: 100, percent: 10 }, cost: { usd: 1.5 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-13T13:00:00Z' }, { kind: 'seven_day', percentUsed: Number.NaN }] } as never)
  expect(card).toEqual({ ...EMPTY, context: { tokens: 10, window: 100, percent: 10 },
    limits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: '2026-10-13T13:00:00Z' }] })
  expect(measured(card, { context: { window: 100 }, rateLimits: [] })).toMatchObject({ context: { window: 100 }, limits: [] })
})

test('a step brings the effort, the model that answered and the cache share; a step without usage keeps them', () => {
  const card = stepped(EMPTY, 'high', { model: 'claude-opus-5-5', input_tokens: 10, cache_read_input_tokens: 950, cache_creation_input_tokens: 40 })
  expect(card).toMatchObject({ effort: 'high', model: 'claude-opus-5-5', cache: 95 })
  expect(stepped(card, 3, null)).toEqual(card)
})

test('the compaction window is kept when positive, and the turn start is cleared when it ends', () => {
  expect(windowed(EMPTY, 500_000)).toMatchObject({ contextWindow: 500_000 })
  for (const bad of [0, -1, Number.NaN, undefined, '500000']) expect(windowed(EMPTY, bad)).toEqual(EMPTY)
  const running = timed(began(EMPTY), 1_000)
  expect(running).toMatchObject({ turnStartedAt: 1_000 })
  expect(completed(running, 5_000)).toEqual({ ...EMPTY, lastTurnMs: 5_000, turns: 1 })
  expect(completed(running, Number.NaN)).toEqual({ ...EMPTY, turns: 1 })
})

test('a turn keeps its duration and counts; an edit counts unless it ended in an error, any error counts, a plain call does not', () => {
  expect(completed(EMPTY, 5_000)).toMatchObject({ lastTurnMs: 5_000, turns: 1 })
  expect(completed(EMPTY, Number.NaN)).toEqual({ ...EMPTY, turns: 1 })
  const uses = [
    { tool_use_id: 'a', tool: 'Edit', text: 'ok' }, { tool_use_id: 'b', tool: 'Write', text: 'denied', isError: true as const },
    { tool_use_id: 'c', tool: 'Bash', text: 'failed', isError: true as const }, { tool_use_id: 'd', tool: 'NotebookEdit', text: 'ok' },
  ]
  expect(counted(EMPTY, uses)).toMatchObject({ edits: 2, errors: 2 })
  expect(counted(EMPTY, [{ tool_use_id: 'r', tool: 'Read', text: 'text' }])).toBe(EMPTY)
})

test('only answered calls not seen before are counted, each once', () => {
  const uses = [{ tool_use_id: 'a', tool: 'Edit', text: 'ok' }, { tool_use_id: 'b', tool: 'Edit' }, { tool_use_id: 'c', tool: 'Bash', text: 'x' }, { tool_use_id: 'a', tool: 'Edit', text: 'ok' }]
  expect(unseen(uses, new Set(['c'])).map(use => use.tool_use_id)).toEqual(['a'])
  expect(unseen([{ tool_use_id: 7, tool: 'Edit', text: 'ok' }] as never, new Set())).toEqual([])
})

test('a turn keeps its first prompt and its last prompt plus output, and joins the history when it ends, the last two kept', () => {
  const usage = (input: number, read: number, output: number) =>
    ({ model: 'claude-opus-5-5', input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: 0 })
  const running = stepped(stepped(began(EMPTY), 'high', usage(100, 1_000, 50)), 'high', usage(400, 1_100, 30))
  expect(running.pending).toEqual({ before: 1_100, after: 1_530, output: 80 })
  const done = completed(running, 10)
  expect(done.history).toEqual([{ before: 1_100, after: 1_530, output: 80 }])
  expect(done.pending).toBeUndefined()
  expect(completed(began(done), 10).history).toHaveLength(1)
  let card = EMPTY
  for (let i = 0; i < HISTORY + 3; i++) card = completed(stepped(began(card), 'high', usage(i, 0, 1)), 1)
  expect(card.history).toHaveLength(HISTORY)
  expect(card.history[0]!.before).toBe(3)
  expect(stepped(EMPTY, 'high', { ...usage(1, 1, 1), output_tokens: Number.NaN }).pending).toBeUndefined()
})

test('a step that reads or writes the cache marks when; a switch keeps only a 5m or 1h lifetime and forgets the use on another model', () => {
  const read = { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 }
  expect([touchedCache(read), touchedCache({ ...read, cache_read_input_tokens: 0 }), touchedCache(null)]).toEqual([true, false, false])
  expect(cacheUsed(EMPTY, 42).cacheUsedAt).toBe(42)
  expect(cacheUsed(EMPTY, Number.NaN)).toBe(EMPTY)
  const used = cacheUsed(EMPTY, 42)
  expect(switched(used, '1h', 'claude-opus-5-5', 'claude-opus-5-5')).toEqual({ ...used, cacheTtl: '1h' })
  expect(switched(used, '5m', 'claude-sonnet-4-5', 'claude-opus-5-5')).toEqual({ ...EMPTY, cacheTtl: '5m' })
  expect(switched(EMPTY, '2h', 'a', 'a')).toEqual(EMPTY)
})

test('a compaction marks the next turn to join the history, once, and waits through a turn with no usage', () => {
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const waiting = completed(began(compactedNow(EMPTY)), 1)
  expect(waiting).toMatchObject({ compacted: true, history: [] })
  const marked = completed(stepped(began(waiting), 'high', usage), 1)
  expect(marked.history).toEqual([{ before: 10, after: 11, output: 1, compacted: true }])
  expect(marked.compacted).toBeUndefined()
  expect(completed(stepped(began(marked), 'high', usage), 1).history[1]).toEqual({ before: 10, after: 11, output: 1 })
})
