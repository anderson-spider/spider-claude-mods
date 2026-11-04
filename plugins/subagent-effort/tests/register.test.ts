import { expect, test } from 'claude-code/testing'
import { call, LEDGER, settle, started, world } from './host'
import { EVAL_COMMAND, EVAL_DESCRIPTION, STATS_COMMAND, STATS_DESCRIPTION } from '../hooks/register'
import { EVAL_BRIEFS } from '../hooks/eval-briefs'
import { OFF_TEXT } from '../hooks/key'
import { CALIBRATION } from '../hooks/effort'

const MARKER = 'SECRET-MARKER-7f3a'
function dispatched(on: Parameters<typeof world>[0], answer: unknown = { result: 'native answer' }) {
  const received: Record<string, unknown>[] = []
  on('tool.call', { tool: 'Agent' }, (_$, e) => { received.push(e as never); return answer as never })
  return received
}
// A model that follows the plugin's refusal: the same call again, with the effort the refusal names.
async function routed($: { tool: { call: (input: never) => Promise<unknown> } }, input: Record<string, unknown>) {
  const first = (await settle($.tool.call(input as never))) as { deny?: string } | undefined
  const effort = /effort: "(\w+)"/.exec(first?.deny ?? '')?.[1]
  return effort ? settle($.tool.call({ ...input, effort } as never)) : first
}
const finished = (patch = {}) => ({
  ref: 'r', text: MARKER, result: {
    agentId: 'a1', status: 'completed', prompt: MARKER, resolvedModel: 'claude-haiku-5-5', totalDurationMs: 42_000,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 500, cache_read_input_tokens: 1000 },
    content: [{ type: 'text', text: MARKER }], ...patch,
  },
})

test('session start registers the stats command and no agent or tool', async ($, on) => {
  const h = world(on); await started($)
  expect(h.commands).toEqual([{ name: STATS_COMMAND, description: STATS_DESCRIPTION }, { name: EVAL_COMMAND, description: EVAL_DESCRIPTION }])
  expect(STATS_COMMAND).toBe('subagent-effort-stats')
})

test('Jev picks the effort of any native agent type: a call without it is sent back to come again with it, untouched', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '2': 1 } }
  await started($)
  const first = (await settle($.tool.call(call({ model: 'haiku', subagent_type: 'Plan' }) as never))) as { deny?: string }
  expect(first.deny).toBe('subagent-effort: Jev rated this task high. Call Agent again with the same input and effort: "high". The input is not changed after review, so auto mode checks what runs.')
  expect(received).toEqual([])
  expect(await settle($.tool.call(call({ model: 'haiku', subagent_type: 'Plan', effort: 'high' }) as never))).toHaveProperty('result', 'native answer')
  // The call that comes back goes as it came: same description, same model, Jev asked once.
  expect(received[0]).toEqual(call({ model: 'haiku', subagent_type: 'Plan', effort: 'high' }))
  expect(h.requests).toHaveLength(1)
  // A call without a type is the host's general-purpose agent, routed the same way.
  const { subagent_type: _, ...untyped } = call({ tool_use_id: 'dispatch-2' })
  await routed($, untyped)
  expect(received[1]).toMatchObject({ effort: 'high' })
  expect(h.requests).toHaveLength(2)
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => l.agentType)).toEqual(['Plan', 'general-purpose'])
})

test('Jev decides over an effort the call came with: another one is sent back, its own goes as it came', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const asked = call({ effort: 'max', model: 'opus', tool_use_id: 'toolu_max' })
  await routed($, asked)
  expect(received[0]).toEqual({ ...asked, effort: 'low' })
  // A call that already has Jev's effort is not sent back.
  expect(await settle($.tool.call(call({ effort: 'low', tool_use_id: 'toolu_low' }) as never))).toHaveProperty('result', 'native answer')
  expect(received[1]).toEqual(call({ effort: 'low', tool_use_id: 'toolu_low' }))
  expect(h.requests).toHaveLength(2)
  expect(h.ledger().map(l => [l.tool_use_id, l.source, l.received, l.effort])).toEqual([['toolu_max', 'jev', 'max', 'low'], ['toolu_low', 'jev', 'low', 'low']])
})

test('when Jev is off or fails, an effort the call came with goes as it came and is recorded as received and applied', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  const asked = call({ effort: 'high', tool_use_id: 'toolu_off' })
  await routed($, asked); expect(received[0]).toEqual(asked)
  h.env.JEV_API_KEY = 'test-key'; h.faults.http = 401
  await routed($, asked); expect(received[1]).toEqual(asked)
  expect(h.ledger().map(l => [l.source, l.jevReason, l.received, l.effort])).toEqual([['off', 'no-key', 'high', 'high'], ['off', 'http', 'high', 'high']])
})

test("an agent type's cap holds Jev's pick down, named in the refusal and recorded beside Jev's own level", async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '3': 1 } }
  await started($)
  await routed($, call({ effort: 'max' }))
  expect(received[0]).toEqual(call({ effort: 'medium' }))
  await routed($, call({ subagent_type: 'claude-code-guide', tool_use_id: 'guide' }))
  expect(received[1]).toEqual(call({ subagent_type: 'claude-code-guide', tool_use_id: 'guide', effort: 'low' }))
  await routed($, call({ subagent_type: 'general-purpose', tool_use_id: 'gp' }))
  expect(received[2]).toEqual(call({ subagent_type: 'general-purpose', tool_use_id: 'gp', effort: 'xhigh' }))
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => [l.agentType, l.effort, l.cap, l.level])).toEqual([['Explore', 'medium', 'medium', 3], ['claude-code-guide', 'low', 'low', 3], ['general-purpose', 'xhigh', null, 3]])
})

test('the caps option replaces the default caps, none turns them off, and a bad entry is logged and dropped', { options: { caps: 'Plan=low, Explore=max, bad' } }, async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '2': 1 } }
  await started($)
  expect(h.logs).toContain('subagent-effort: caps entries ignored: Explore=max, bad')
  await routed($, call({ subagent_type: 'Plan' }))
  await routed($, call())
  expect(received.map(r => r.effort)).toEqual(['low', 'high'])
})

test('a cap never touches a call Jev did not route', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await routed($, call({ effort: 'xhigh' }))
  expect(received[0]).toEqual(call({ effort: 'xhigh' }))
  expect(h.ledger()[0]).toMatchObject({ source: 'off', effort: 'xhigh', cap: null })
})

test('a fork or an empty task passes untouched, unrouted and unrecorded', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const fork = call({ subagent_type: 'fork', effort: 'max' })
  await settle($.tool.call(fork as never)); expect(received[0]).toEqual(fork)
  const empty = call({ prompt: '  ' })
  await settle($.tool.call(empty as never)); expect(received[1]).toEqual(empty)
  expect(h.requests).toHaveLength(0); expect(h.written).toHaveLength(0)
})

test('when Jev is off the call goes as it came, with one toast per reason in this load', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  await routed($, call()); await routed($, call())
  expect(received).toEqual([call(), call()])
  expect(h.toasts).toEqual([`Jev off (no-key): ${OFF_TEXT['no-key']} Subagent calls go as they came.`])
  h.env.JEV_API_KEY = 'has space'
  await routed($, call())
  expect(h.toasts).toHaveLength(2); expect(h.toasts[1]).toContain('Jev off (bad-key)')
  // A Jev failure is not a configuration problem: no toast.
  h.env.JEV_API_KEY = 'test-key'; h.faults.http = 401
  await routed($, call())
  expect(received[3]).toEqual(call()); expect(h.toasts).toHaveLength(2)
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => [l.source, l.effort, l.jevReason])).toEqual([['off', null, 'no-key'], ['off', null, 'no-key'], ['off', null, 'bad-key'], ['off', null, 'http']])
})

test('a routing failure dispatches the call once as it came and writes no record', async ($, on) => {
  const h = world(on), received = dispatched(on); await started($)
  Object.defineProperty(h.io, 'root', { get: () => { throw new Error('root unavailable') } })
  expect(await routed($, call())).toHaveProperty('result', 'native answer')
  expect(received).toEqual([call()])
  expect(h.written).toHaveLength(0)
  expect(h.logs).toContain('subagent-effort: routing failed; dispatching the call as it came.')
})

test('a decision line and a foreground outcome line are written, and the host result passes on as it came', async ($, on) => {
  const h = world(on), answer = finished(); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '0': 0.8, '1': 0.2 } }
  dispatched(on, answer); await started($)
  expect(await routed($, call({ tool_use_id: 'toolu_1' }))).toEqual(answer)
  expect(h.ledger()).toEqual([
    { v: 1, kind: 'decision', calibration: CALIBRATION, ts: expect.any(String), tool_use_id: 'toolu_1', agentType: 'Explore', briefChars: 12, source: 'jev', received: null, effort: 'low', cap: null, level: 0, headLevel: 0, fullLevel: null, top: 0.8, jevReason: null, jevMs: expect.any(Number), jevTokens: { input: 300, output: 20 }, jevCostUsd: 0.0000126, sentBack: 1, sentBackMs: 0 },
    { v: 1, kind: 'outcome', ts: expect.any(String), tool_use_id: 'toolu_1', agentType: 'Explore', effort: 'low', mode: 'foreground', resolvedModel: 'claude-haiku-5-5', status: 'completed', durationMs: 42_000, tokens: 1650, errorClass: null },
  ])
})

test('an error of a call run in background, flagged true or "true", is written as a background outcome', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  dispatched(on, { ref: 'r', text: 'the agent failed', result: 'the agent failed', isError: true }); await started($)
  await routed($, call({ tool_use_id: 'toolu_t', run_in_background: true }))
  await routed($, call({ tool_use_id: 'toolu_s', run_in_background: 'true' }))
  await routed($, call({ tool_use_id: 'toolu_f' }))
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => [l.tool_use_id, l.mode, l.status]))
    .toEqual([['toolu_t', 'background', 'error'], ['toolu_s', 'background', 'error'], ['toolu_f', 'foreground', 'error']])
})

test("in the desktop app or VS Code, where the main conversation's agents always run in background, an error is a background outcome", async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  h.surfaces.splice(0, 1, 'desktop')
  dispatched(on, { ref: 'r', text: 'the agent failed', result: 'the agent failed', isError: true }); await started($)
  await routed($, call({ tool_use_id: 'toolu_main' }))
  // A subagent's own Agent call runs in the foreground there unless it asks otherwise.
  await routed($, call({ tool_use_id: 'toolu_sub', agentId: 'agent-1' }))
  await routed($, call({ tool_use_id: 'toolu_sub_bg', agentId: 'agent-1', run_in_background: true }))
  expect(h.ledger().filter(l => l.kind === 'outcome').map(l => [l.tool_use_id, l.mode]))
    .toEqual([['toolu_main', 'background'], ['toolu_sub', 'foreground'], ['toolu_sub_bg', 'background']])
})

test('a background launch is written when its turn completes, once, and other turns write nothing', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  const launched = { ref: 'r', text: MARKER, result: { status: 'async_launched', agentId: 'bg-1', prompt: MARKER } }
  dispatched(on, launched)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await started($)
  expect(await routed($, call({ tool_use_id: 'toolu_bg' }))).toEqual(launched)
  expect(h.ledger().map(l => l.kind)).toEqual(['decision'])
  const done = { turnId: 't1', agentId: 'bg-1', answer: MARKER, durationMs: 7000, isAborted: false, reason: 'answer', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  await settle($.turn.complete({ ...done, agentId: 'other' } as never))
  await settle($.turn.complete({ ...done, agentId: undefined } as never))
  expect(h.ledger()).toHaveLength(1)
  expect(await settle($.turn.complete(done as never))).toEqual({ text: MARKER })
  expect(h.ledger()[1]).toMatchObject({ kind: 'outcome', tool_use_id: 'toolu_bg', mode: 'background', status: 'completed', durationMs: 7000, tokens: 15, resolvedModel: 'claude-opus-5-5', effort: 'low' })
  await settle($.turn.complete(done as never))
  expect(h.ledger()).toHaveLength(2)
})

test('no line ever holds the task, a prompt, an answer, a path or the key', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  h.answers.reasoning = { probabilities: { '1': 1 }, reason: MARKER, [MARKER]: 1 }
  dispatched(on, finished({ prompt: MARKER, resolvedModel: MARKER + ' /home/u' }))
  await started($)
  await routed($, call({ prompt: `Review ${MARKER} at /home/u/private/${MARKER} with test-key`, description: `Fixture ${MARKER}`, subagent_type: `/home/u/${MARKER} x` }))
  expect(h.written.length).toBeGreaterThan(0)
  for (const text of [...h.written, ...h.files.values()]) {
    expect(text).not.toContain(MARKER); expect(text).not.toContain('/home/u'); expect(text).not.toContain('test-key'); expect(text).not.toContain('Review')
  }
  expect(h.ledger()[0]).toMatchObject({ agentType: null, briefChars: expect.any(Number) })
})

test('observation survives a failing ledger: the dispatch and its result are unchanged and one debug line names the miss', async ($, on) => {
  const h = world(on), answer = finished(); h.env.JEV_API_KEY = 'test-key'
  const received = dispatched(on, answer)
  await started($)
  h.fsFaults.write = true
  expect(await routed($, call())).toEqual(answer)
  expect(received[0]).toMatchObject({ effort: 'low' })
  expect(h.logs.filter(line => line.endsWith('not recorded'))).toEqual(['subagent-effort: decision not recorded', 'subagent-effort: outcome not recorded'])
  h.fsFaults.write = false
  // A ledger that cannot be read is not overwritten either.
  h.files.set(LEDGER, '{"keep":"me"}\n'); h.fsFaults.read = true
  expect(await routed($, call())).toEqual(answer)
  expect(h.files.get(LEDGER)).toBe('{"keep":"me"}\n')
  // A host without HOME writes nothing and still dispatches.
  h.fsFaults.read = false; delete h.env.HOME; h.written.length = 0
  expect(await routed($, call())).toEqual(answer)
  expect(h.written).toHaveLength(0)
})

test('the stats command checks Jev access the way routing does, summarizes the records and never prints the key', async ($, on) => {
  const h = world(on); dispatched(on, finished())
  await started($)
  expect((await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text).toBe(`Jev access in this session: off (no-key). ${OFF_TEXT['no-key']}\nno routing records yet.`)
  h.env.JEV_API_KEY = 'test-key'
  await routed($, call())
  const text = (await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text
  expect(text).toMatch(/^Jev access in this session: ok \(key from JEV_API_KEY\)\.\n1 decisions: Jev 1, Jev off 0\.\nJev calls: 1, median \d+ms, 300 input and 20 output tokens, about \$0\.000013 \(estimated\)\.\nSent back: 1 of 1 calls, median 0s to come back\.\n2 groups with fewer than 3 runs left out\.$/)
  expect(text).not.toContain('test-key')
  h.fsFaults.read = true
  expect((await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text).toBe('Jev access in this session: ok (key from JEV_API_KEY).\nthe routing records could not be read.')
})

test('the eval command rates every fixed brief once per round over the routing transport, records nothing and never prints the key', async ($, on) => {
  const h = world(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const run = async (args: string) => ((await $.command.run({ command: EVAL_COMMAND, args } as never)) as { text: string }).text
  const text = await run('1 holdout')
  const holdout = EVAL_BRIEFS.filter(b => b.split === 'holdout'), long = holdout.filter(b => b.task.length > 800).length
  // One call per brief, and one more for each brief longer than the head.
  expect(h.requests).toHaveLength(holdout.length + long)
  expect(h.requests.every(r => r.headers.Authorization === 'Bearer test-key')).toBe(true)
  expect(text.split('\n')[0]).toBe(`${holdout.length} briefs × 1 rounds; levels 0-3 are low, medium, high, xhigh; each round shows decided(head/full).`)
  expect(text).toContain('h-lookup [holdout] expected 0: 0(0/-)')
  expect(text).not.toContain('test-key')
  expect(h.files.has(LEDGER)).toBe(false)
  expect(await run('9')).toBe('usage: /subagent-effort-eval [1-5] [dev|holdout]')
})

test("a failing evaluation never pauses routing: it has a breaker of its own", async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  // A 401 counts against a breaker and is not retried: enough failures in a row would pause a shared one.
  h.faults.http = 401
  const text = ((await $.command.run({ command: EVAL_COMMAND, args: '1 dev' } as never)) as { text: string }).text
  expect(text).toMatch(/failed:(http|breaker)/)
  h.faults.http = 200
  await routed($, call())
  expect(received[0]).toHaveProperty('effort', 'low')
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => [l.source, l.jevReason])).toEqual([['jev', null]])
})

const OPTION_KEY = ['option-', 'test', '-key'].join('')
test('the apiKey option is the key Jev gets, over JEV_API_KEY, and the stats command names its source', { options: { apiKey: OPTION_KEY } }, async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'env-test-key'
  await started($)
  await routed($, call())
  expect(h.requests[0]!.headers.Authorization).toBe(`Bearer ${OPTION_KEY}`)
  expect(received[0]).toHaveProperty('effort', 'low')
  const text = (await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text
  expect(text.split('\n')[0]).toBe('Jev access in this session: ok (key from the apiKey option).')
  expect(text).not.toContain(OPTION_KEY)
})

test('an apiKey option that the repository settings declare turns Jev off and sends nothing', { options: { apiKey: OPTION_KEY } }, async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'env-test-key'
  h.io.settings = async () => ({ pluginConfigs: { 'subagent-effort@spider-claude-mods': { options: { apiKey: 'repo-key-123' } } } })
  await started($)
  await routed($, call())
  expect(h.requests).toHaveLength(0)
  expect(received[0]).not.toHaveProperty('effort')
  expect(h.toasts).toEqual([`Jev off (repo-declared-key): ${OFF_TEXT['repo-declared-key']} Subagent calls go as they came.`])
})

test('a call that comes back twice with another effort goes as it came, so a model that will not follow never loops', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const stubborn = call({ effort: 'max' })
  for (let i = 0; i < 2; i++) expect(((await settle($.tool.call(stubborn as never))) as { deny?: string }).deny).toMatch(/effort: "low"/)
  expect(await settle($.tool.call(stubborn as never))).toHaveProperty('result', 'native answer')
  expect(received).toEqual([stubborn])
  expect(h.requests).toHaveLength(1)
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => [l.source, l.received, l.effort])).toEqual([['jev', 'max', 'max']])
  expect(h.logs).toContain('subagent-effort: Explore came back 2 times without Jev\'s low; it goes as it came (max).')
})

test('a decision records how many times its call was sent back and the time from the first refusal until it went', async ($, on) => {
  const h = world(on); dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  // Sent back once, back after 5 s.
  expect(((await settle($.tool.call(call({ tool_use_id: 'once' }) as never))) as { deny?: string }).deny).toMatch(/effort: "low"/)
  await h.clock.advance(5000)
  await settle($.tool.call(call({ tool_use_id: 'once', effort: 'low' }) as never))
  // Sent back twice, then it goes as it came: the wait counts from the first refusal.
  const stubborn = call({ effort: 'max', description: 'stubborn', tool_use_id: 'twice' })
  await settle($.tool.call(stubborn as never)); await h.clock.advance(1000)
  await settle($.tool.call(stubborn as never)); await h.clock.advance(2000)
  await settle($.tool.call(stubborn as never))
  // A call that already has Jev's effort goes at once.
  await settle($.tool.call(call({ effort: 'low', description: 'direct', tool_use_id: 'direct' }) as never))
  expect(h.ledger().filter(l => l.kind === 'decision').map(l => [l.tool_use_id, l.sentBack, l.sentBackMs])).toEqual([['once', 1, 5000], ['twice', 2, 3000], ['direct', 0, null]])
})

test('parallel calls with the same task are each sent back for Jev’s effort: each waits apart, by its description', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'test-key'
  await started($)
  const probes = [1, 2, 3, 4].map(n => call({ description: `probe ${n}`, tool_use_id: `probe-${n}` }))
  // The host hands them to the hook one after the other: each comes before the others come back.
  const first: { deny?: string }[] = []
  for (const probe of probes) first.push((await settle($.tool.call(probe as never))) as { deny?: string })
  expect(first.map(answer => answer.deny)).toEqual(probes.map(() => expect.stringMatching(/effort: "low"/)))
  expect(received).toEqual([])
  await Promise.all(probes.map(probe => settle($.tool.call({ ...probe, effort: 'low' } as never))))
  expect(received.map(r => [r.description, r.effort])).toEqual(probes.map(probe => [probe.description, 'low']))
})

test('SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY is the key Jev gets, over JEV_API_KEY, and the stats command names it', async ($, on) => {
  const h = world(on), received = dispatched(on); h.env.JEV_API_KEY = 'jev-test-key'; h.env.SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY = 'spider-test-key'
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  const text = (await $.command.run({ command: STATS_COMMAND } as never) as { text: string }).text
  expect(text).toMatch(/^Jev access in this session: ok \(key from SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY\)\./)
  expect(received).toBeDefined()
})
