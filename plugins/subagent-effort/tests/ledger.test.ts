import { expect, test } from 'claude-code/testing'
import { CALIBRATION } from '../hooks/effort'
import { afterAgentCall, afterTurn, runsInBackground, appendLine, decisionLine, errorClassOf, familyOf, formatSummary, MIN_RUNS, parseLedger, readAll, ROTATE_AT, rotatedPath, summarize, usd } from '../hooks/ledger'
import type { FileIo, Line } from '../hooks/ledger'

const ctx = { toolUseId: 'toolu_1', agentType: 'Explore', effort: 'medium' as const, background: false, model: null }
const ts = '2026-10-17T00:00:00.000Z'

test('a decision line projects each field and drops anything that is not a plain word or a count', () => {
  expect(decisionLine({ ts, toolUseId: 'bad id/with path', agentType: 'Explore', briefChars: 12.4, source: 'jev', received: 'max', effort: 'high', choice: { effort: 'high', level: 2, top: 0.876, jevReason: null, jevMs: 210, jevTokens: { input: 308.4, output: 19 } } }))
    .toEqual({ v: 1, kind: 'decision', calibration: CALIBRATION, ts, tool_use_id: null, agentType: 'Explore', briefChars: 12, source: 'jev', received: 'max', effort: 'high', cap: null, level: 2, headLevel: null, fullLevel: null, top: 0.88, jevReason: null, jevMs: 210, jevTokens: { input: 308, output: 19 }, jevCostUsd: 0.000012936, sentBack: null, sentBackMs: null })
  expect(decisionLine({ ts, toolUseId: 'toolu_3', agentType: 'Explore', briefChars: 1, source: 'jev', received: null, effort: 'medium', cap: 'medium', choice: { effort: 'high', level: 2, top: 0.9, jevReason: null, jevMs: 1, jevTokens: null } }))
    .toMatchObject({ effort: 'medium', cap: 'medium', level: 2 })
  expect(decisionLine({ ts, toolUseId: 'toolu_2', agentType: 'plugin:agent', briefChars: 3, source: 'off', received: null, effort: null, choice: { effort: null, level: null, top: null, jevReason: 'no-key', jevMs: null, jevTokens: null } }))
    .toMatchObject({ jevTokens: null, jevCostUsd: null, agentType: 'plugin:agent', source: 'off', received: null, effort: null, level: null, top: null, jevReason: 'no-key' })
})

test('the Agent result becomes a foreground outcome, a background launch, or nothing for a refusal or an unknown shape', () => {
  const usage = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }
  expect(afterAgentCall(ctx, { result: { status: 'completed', resolvedModel: 'claude-sonnet-5-5', totalDurationMs: 1500, usage } }, ts))
    .toEqual({ v: 1, kind: 'outcome', ts, tool_use_id: 'toolu_1', agentType: 'Explore', effort: 'medium', mode: 'foreground', resolvedModel: 'claude-sonnet-5-5', status: 'completed', durationMs: 1500, tokens: 10, errorClass: null })
  expect(afterAgentCall(ctx, { isError: true }, ts)).toMatchObject({ status: 'error', mode: 'foreground', resolvedModel: null, tokens: null, durationMs: null, errorClass: 'other' })
  // Without a resolved model the call's own model stands in; an error of a background call keeps its mode.
  const asked = { ...ctx, background: true, model: 'sonnet' }
  expect(afterAgentCall(asked, { isError: true }, ts)).toMatchObject({ status: 'error', mode: 'background', resolvedModel: 'sonnet' })
  expect(afterAgentCall({ ...asked, background: false }, { result: { status: 'completed', totalDurationMs: 1, usage } }, ts)).toMatchObject({ mode: 'foreground', resolvedModel: 'sonnet' })
  expect(afterAgentCall(asked, { result: { status: 'completed', resolvedModel: 'claude-opus-5-5', totalDurationMs: 1, usage } }, ts)).toMatchObject({ resolvedModel: 'claude-opus-5-5' })
  expect(afterAgentCall(ctx, { result: { status: 'async_launched', agentId: 'bg' } }, ts)).toEqual({ launched: 'bg' })
  // A call the permission check denied never ran, like a hook's deny.
  const denied = { isError: true, text: 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass].' }
  for (const result of [{ deny: 'no' }, denied, null, 'text', { result: 'text' }, { result: { status: 'async_launched' } }, { result: { status: 'teammate_spawned' } }]) expect(afterAgentCall(ctx, result, ts)).toBeNull()
})

test('an error the Agent call returned is recorded by its class, never by its text, and counted per class when it never ran', () => {
  const texts: [unknown, string][] = [
    ["The user doesn't want to proceed with this tool use. The tool use was rejected", 'rejected'],
    ['[Request interrupted by user for tool use]', 'rejected'],
    ['<tool_use_error>Cancelled: Claude ended the conversation</tool_use_error>', 'cancelled'],
    ["Agent type 'nope' not found. Available agents: Explore, Plan", 'unknown-type'],
    ['<tool_use_error>InputValidationError: prompt is required</tool_use_error>', 'invalid-input'],
    ['Error: /home/u/private/secret failed', 'other'], [undefined, 'other'], [42, 'other'],
  ]
  for (const [text, kind] of texts) {
    expect(errorClassOf(text)).toBe(kind)
    const line = afterAgentCall(ctx, { isError: true, text }, ts)
    expect(line).toMatchObject({ status: 'error', errorClass: kind })
    expect(JSON.stringify(line)).not.toContain('private')
  }
  // A line written before the class was recorded counts as unclassified.
  const early = (text: string, id: string) => afterAgentCall({ ...ctx, toolUseId: id }, { isError: true, text }, ts) as Line
  const legacy = { ...early('x', 'c'), errorClass: undefined } as unknown as Line
  const decided = decisionLine({ ts, toolUseId: 'a', agentType: 'Explore', briefChars: 1, source: 'off', received: null, effort: null })
  const summary = summarize(parseLedger([decided, early('Cancelled: x', 'a'), early('Cancelled: y', 'b'), legacy, early('boom', 'd')].map(l => JSON.stringify(l)).join('\n')))
  expect(summary).toMatchObject({ notRun: 4, notRunBy: { cancelled: 2, unclassified: 1, other: 1 } })
  expect(formatSummary(summary).split('\n').at(-1)).toBe('4 calls never ran (an error before the agent started: cancelled ×2, other ×1, unclassified ×1), left out.')
})

test('a background turn end is an outcome with its status from the reason', () => {
  const turn = { durationMs: 900, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  expect(afterTurn(ctx, turn, ts)).toMatchObject({ mode: 'background', status: 'completed', durationMs: 900, tokens: 2, resolvedModel: 'claude-opus-5-5' })
  expect(afterTurn(ctx, { ...turn, isAborted: true }, ts).status).toBe('aborted')
  expect(afterTurn(ctx, { ...turn, reason: 'error' }, ts)).toMatchObject({ status: 'error', errorClass: null })
  expect(afterTurn(ctx, { durationMs: 1, isAborted: false, reason: 'refusal' }, ts)).toMatchObject({ status: 'refusal', tokens: null, resolvedModel: null })
})

function memory(): FileIo & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return { files, exists: async p => files.has(p), read: async p => files.get(p)!, write: async (p, t) => { files.set(p, t) } }
}

test('appends keep every line, rotate past the limit, and readAll joins both generations', async () => {
  const io = memory(), path = '/h/.claude/subagent-effort/routes.jsonl'
  const line = decisionLine({ ts, toolUseId: 'a', agentType: 'Explore', briefChars: 1, source: 'off', received: 'low', effort: 'low' })
  await Promise.all([appendLine(io, path, line), appendLine(io, path, line)])
  expect(io.files.get(path)!.split('\n').filter(Boolean)).toHaveLength(2)
  io.files.set(path, 'x'.repeat(ROTATE_AT))
  await appendLine(io, path, line)
  expect(io.files.get(rotatedPath(path))).toBe('x'.repeat(ROTATE_AT) + '\n')
  expect(parseLedger(await readAll(io, path))).toEqual([line])
})

test('the summary groups outcomes by model family and effort, and counts decisions per source and the explicit efforts Jev replaced', () => {
  const decision = (source: 'jev' | 'off', received: 'low' | 'max' | null = null, jevReason: string | null = null) => decisionLine({ ts, toolUseId: 'a', agentType: 'Explore', briefChars: 1, source, received, effort: source === 'off' ? received : 'low', choice: source === 'jev' ? { effort: 'low', level: 0, top: 1, jevReason: null, jevMs: 200, jevTokens: { input: 1_000_000, output: 20 } } : { effort: null, level: null, top: null, jevReason: jevReason as never, jevMs: null, jevTokens: null } })
  const run = (effort: 'low' | null, model: string, durationMs: number, tokens: number, status: 'completed' | 'error' = 'completed') => ({ ...afterAgentCall({ ...ctx, effort }, { result: { status: 'completed', resolvedModel: model, totalDurationMs: durationMs, usage: { input_tokens: tokens } } }, ts) as Line, status })
  // Jev replacing max counts as an override; Jev picking the effort the call already had does not, nor does Jev off.
  const lines: Line[] = [decision('jev', 'max'), decision('jev', 'low'), decision('off', 'max', 'no-key'), { ...decision('jev'), calibration: 0 },
    run('low', 'claude-haiku-5-5', 10_000, 2000), run('low', 'claude-haiku-5-5', 30_000, 4000, 'error'), run(null, 'claude-opus-5-5', 60_000, 1_500_000)]
  const text = parseLedger(lines.map(l => JSON.stringify(l)).join('\n') + '\nnot json\n{"v":1,"kind":"decision","source":"x","effort":null}')
  const summary = summarize(text)
  expect(summary).toMatchObject({ decisions: 4, bySource: { jev: 3, off: 1 }, overridden: 1, offReasons: { 'no-key': 1 }, olderCalibration: 1 })
  // Jev's own calls are summed apart from the subagents: the decision off asked nothing.
  expect(summary.jev).toEqual({ asked: 3, medianMs: 200, inputTokens: 3_000_000, outputTokens: 60, costUsd: 0.126 })
  expect(summary.groups).toEqual([
    { key: 'haiku/low', runs: 2, failures: 1, medianMs: 20_000, medianTokens: 3000 },
    { key: 'opus/usual', runs: 1, failures: 0, medianMs: 60_000, medianTokens: 1_500_000 },
  ])
  expect(summary.byType).toEqual([{ key: 'Explore', runs: 3, failures: 1, medianMs: 30_000, medianTokens: 4000 }])
  expect(formatSummary(summary)).toBe('4 decisions: Jev 3 (1 replacing the call\'s effort), Jev off 1 (no-key ×1); 1 from an older calibration.\nJev calls: 3, median 200ms, 3M input and 60 output tokens, about $0.13 (estimated).\nBy agent type:\n  Explore: 3 runs, 1 failed, median 30s and 4k tokens\n2 groups with fewer than 3 runs left out.')
  expect(formatSummary(summarize([]))).toBe('no routing records yet.')
  expect([familyOf('claude-fable-5-1'), familyOf(null), familyOf('gpt')]).toEqual(['fable', '?', '?'])
})

test('calls that never ran and runs of an older calibration stay out of the groups, and caps that lowered Jev are counted', () => {
  const decide = (id: string, calibration: number, cap: 'medium' | null = null) => ({ ...decisionLine({ ts, toolUseId: id, agentType: 'Explore', briefChars: 1, source: 'jev', received: null, effort: 'medium', cap, choice: { effort: 'high', level: 2, top: 1, jevReason: null, jevMs: 1, jevTokens: null } }), calibration })
  const ran = (id: string) => afterAgentCall({ ...ctx, toolUseId: id }, { result: { status: 'completed', resolvedModel: 'claude-haiku-5-5', totalDurationMs: 1000, usage: { input_tokens: 10 } } }, ts) as Line
  const failedEarly = afterAgentCall({ ...ctx, toolUseId: 'gone' }, { isError: true }, ts) as Line
  const summary = summarize([decide('old', 2), ran('old'), decide('new', CALIBRATION, 'medium'), ran('new'), decide('gone', CALIBRATION), failedEarly])
  expect(summary).toMatchObject({ capped: 1, notRun: 1, olderRuns: 1, olderCalibration: 1 })
  expect(summary.groups).toEqual([{ key: 'haiku/medium', runs: 1, failures: 0, medianMs: 1000, medianTokens: 10 }])
  expect(formatSummary(summary).split('\n')).toEqual([
    '3 decisions: Jev 3 (1 lowered by a cap), Jev off 0; 1 from an older calibration.',
    'Jev calls: 3, median 1ms, 0 input and 0 output tokens, about $0 (estimated).',
    '2 groups with fewer than 3 runs left out.',
    '1 calls never ran (an error before the agent started: other ×1), left out.',
    '1 runs from an older calibration, left out.',
  ])
})

test("this calibration's decisions compare the head's level with the full brief's; one without both levels is left out", () => {
  const decide = (headLevel: number, fullLevel: number | null, calibration = CALIBRATION) => ({ ...decisionLine({ ts, toolUseId: `t${headLevel}${fullLevel}`, agentType: 'Explore', briefChars: 1, source: 'jev', received: null, effort: 'low', choice: { effort: 'low', level: Math.max(headLevel, fullLevel ?? 0), top: 1, jevReason: null, jevMs: null, jevTokens: null, headLevel, fullLevel } }), calibration })
  const summary = summarize([decide(1, 1), decide(1, 2), decide(0, 2), decide(2, 1), decide(1, null), decide(0, 3, 2)])
  // Only the head 0, full 2 decision passed the one-level limit; the older calibration's 0 and 3 is left out.
  expect(summary.headVsFull).toEqual({ same: 1, lower: 2, higher: 1, cappedRaise: 1 })
  expect(formatSummary(summary).split('\n')[1]).toBe('Head vs full brief: 1 same, 2 raised by the full brief (1 held to 1 above the head), 1 higher with the head.')
})

test('a group with fewer than three runs is left out of the text and counted, while the summary keeps it', () => {
  expect(MIN_RUNS).toBe(3)
  const run = (id: string, model: string) => afterAgentCall({ ...ctx, toolUseId: id }, { result: { status: 'completed', resolvedModel: model, totalDurationMs: 2000, usage: { input_tokens: 5 } } }, ts) as Line
  const summary = summarize([run('a', 'claude-haiku-5-5'), run('b', 'claude-haiku-5-5'), run('c', 'claude-haiku-5-5'), run('d', 'claude-opus-5-5')])
  expect(summary.groups.map(g => [g.key, g.runs])).toEqual([['haiku/medium', 3], ['opus/medium', 1]])
  expect(formatSummary(summary).split('\n').slice(-4)).toEqual([
    'haiku/medium: 3 runs, median 2s and 5 tokens', 'By agent type:', '  Explore: 4 runs, median 2s and 5 tokens', '1 groups with fewer than 3 runs left out.',
  ])
})

test("a call sent back is counted with its wait until it went; lines that do not record it are left out", () => {
  const decide = (id: string, sentBack?: { count: number; ms: number | null }, calibration = CALIBRATION) => ({ ...decisionLine({ ts, toolUseId: id, agentType: 'Explore', briefChars: 1, source: 'jev', received: null, effort: 'low', sentBack }), calibration })
  // Each field is projected as a count: anything else is null.
  expect(decide('x', { count: 2.4, ms: 1500.6 })).toMatchObject({ sentBack: 2, sentBackMs: 1501 })
  expect(decide('y', { count: -1, ms: 'soon' as never })).toMatchObject({ sentBack: null, sentBackMs: null })
  const summary = summarize([decide('a', { count: 1, ms: 4000 }), decide('b', { count: 1, ms: 8000 }), decide('c', { count: 0, ms: null }), decide('d'), decide('e', { count: 1, ms: 1 }, 2)])
  expect(summary.sentBack).toEqual({ measured: 3, calls: 2, medianMs: 6000 })
  expect(formatSummary(summary).split('\n')).toContain('Sent back: 2 of 3 calls, median 6s to come back.')
  expect(formatSummary(summarize([decide('d')]))).not.toContain('Sent back')
})

test('a dollar amount keeps two significant digits however small, and at least two decimals', () => {
  expect([usd(0.000042966), usd(0.0000126), usd(0.00000043), usd(0.126), usd(1.5), usd(12.345)]).toEqual(['$0.000043', '$0.000013', '$0.00000043', '$0.13', '$1.50', '$12.35'])
  expect([usd(0), usd(-1), usd(NaN), usd(Infinity)]).toEqual(['$0', '$0', '$0', '$0'])
})

test('a call runs in background when it asks to, or when the desktop app or VS Code runs the main conversation there', () => {
  expect(runsInBackground({ flag: true, surfaces: ['terminal'], fromSubagent: false })).toBe(true)
  expect(runsInBackground({ flag: 'true', surfaces: [], fromSubagent: true })).toBe(true)
  expect(runsInBackground({ flag: undefined, surfaces: ['terminal'], fromSubagent: false })).toBe(false)
  expect(runsInBackground({ flag: false, surfaces: ['desktop'], fromSubagent: false })).toBe(true)
  expect(runsInBackground({ flag: undefined, surfaces: ['vscode'], fromSubagent: false })).toBe(true)
  expect(runsInBackground({ flag: undefined, surfaces: ['desktop'], fromSubagent: true })).toBe(false)
  // A terminal session the desktop app also attached to still runs in the terminal.
  expect(runsInBackground({ flag: undefined, surfaces: ['terminal', 'desktop'], fromSubagent: false })).toBe(false)
})
