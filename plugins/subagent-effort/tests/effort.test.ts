import { expect, test } from 'claude-code/testing'
import { assessEffort, CALIBRATION, distribution, EFFORTS, JEV_INPUT_USD_PER_MTOK, jevCostOf, levelOf, POLICY, QUESTION, TASK_CHARS, FULL_CHARS, MAX_RAISE } from '../hooks/effort'
import type { Answers } from '../hooks/jev'
import { createBreaker, createGate } from '../hooks/jev'
import { ports } from './host'

test('one question with one criterion per effort, from low to xhigh, and never max', () => {
  expect(Object.keys(QUESTION)).toEqual(['reasoning'])
  expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(QUESTION.reasoning.criteria).toHaveLength(EFFORTS.length)
  expect(QUESTION.reasoning.instructions).toContain('Judge the work itself, not the length or detail of the brief')
  expect(QUESTION.reasoning.instructions).toContain('Breadth is not depth')
  expect(QUESTION.reasoning.criteria[1]).toContain('mapping or inventorying the code of one area however thoroughly')
  expect(CALIBRATION).toBe(4)
})

test('the level minimizes expected penalty with spare effort weighted 1.5 and ties going lower', () => {
  expect(POLICY).toEqual({ under: 1, over: 1.5 })
  expect(levelOf({ '0': 1, '1': 0, '2': 0, '3': 0 })).toBe(0)
  expect(levelOf({ '0': 0, '1': 0, '2': 0, '3': 1 })).toBe(3)
  // Even odds between 0 and 1: spare effort costs more, so the cheaper level wins.
  expect(levelOf({ '0': 0.5, '1': 0.5 })).toBe(0)
  // The higher of two adjacent levels needs more than 60% of their weight: a split judgment stays on the cheaper level.
  expect(levelOf({ '1': 0.45, '2': 0.55 })).toBe(1)
  expect(levelOf({ '1': 0.35, '2': 0.65 })).toBe(2)
  // Exactly 60% on the higher level is a tie, which rounding keeps on the lower level despite the float error of 0.4 x 1.5.
  expect(levelOf({ '0': 0.4, '1': 0.6 })).toBe(0)
  // Distant levels: the low one keeps a 45% share; a clear majority on the high one moves it.
  expect(levelOf({ '0': 0.45, '3': 0.55 })).toBe(0)
  expect(levelOf({ '0': 0.3, '3': 0.7 })).toBe(3)
})

test('probabilities normalize omitted entries and invalid distributions fail closed', () => {
  expect(distribution({ reasoning: { probabilities: { '0': 0.2, '1': 0.2 } } })).toEqual({ '0': 0.5, '1': 0.5, '2': 0, '3': 0 })
  for (const probs of [undefined, [], {}, { '0': 0 }, { '0': -1 }, { '0': '1' }, { '0': true }, { '0': NaN }, { '0': Infinity }, { '0': 2 }, { '4': 1 }, { '0.5': 1 }, { secret: 1 }]) {
    expect(() => distribution({ reasoning: { probabilities: probs } } as Answers)).toThrow('probabilities')
  }
  expect(() => distribution({})).toThrow('probabilities')
})

const ask = (h: ReturnType<typeof ports>, key: string | null = 'test-key') =>
  assessEffort(h.io, { task: 'Task', home: h.io.home, root: h.io.root, keys: { env: key ?? undefined } })

test('each level of Jev answer selects its effort, with its confidence, latency and reported tokens', async () => {
  for (const [level, effort] of EFFORTS.entries()) {
    const h = ports(); h.answers.reasoning = { probabilities: { [level]: 1 } }
    expect(await ask(h)).toEqual({ effort, level, top: 1, jevReason: null, jevMs: 0, jevTokens: { input: 300, output: 20 }, headLevel: level, fullLevel: null })
    expect(Object.keys(JSON.parse(h.requests[0]!.body).questions)).toEqual(['reasoning'])
    expect(h.requests).toHaveLength(1)
  }
  const h = ports(); h.answers.reasoning = { probabilities: { '1': 0.75, '2': 0.25 } }
  let clock = 100; h.io.jev.now = () => (clock += 40)
  const choice = await ask(h)
  expect(choice).toMatchObject({ effort: 'medium', level: 1, top: 0.75 })
  expect(choice.jevMs).toBeGreaterThan(0)
  // A response without usage still routes; its tokens are unknown.
  const bare = ports(); bare.usage.value = undefined
  expect(await ask(bare)).toMatchObject({ effort: 'low', jevTokens: null })
})

test('the estimated Jev cost charges input tokens only, at the published rate', () => {
  expect(JEV_INPUT_USD_PER_MTOK).toBe(0.042)
  expect(jevCostOf({ input: 1_000_000, output: 500 })).toBe(0.042)
  expect(jevCostOf({ input: 308, output: 19 })).toBe(0.000012936)
  expect(jevCostOf({ input: 0, output: 99 })).toBe(0)
})

test('every assessment failure picks no effort, names the reason, and a logging failure changes nothing', async () => {
  for (const reason of ['no-key', 'bad-key', 'unreadable-settings', 'repo-declared-key', 'http', 'malformed', 'breaker', 'busy', 'timeout', 'network'] as const) {
    const h = ports(); let key: string | undefined = 'test-key'
    if (reason === 'no-key') key = undefined
    if (reason === 'bad-key') key = 'has space'
    if (reason === 'unreadable-settings') h.faults.settings = true
    if (reason === 'repo-declared-key') h.io.settings = async () => ({ env: { JEV_API_KEY: key } })
    if (reason === 'http') h.faults.http = 401
    if (reason === 'malformed') h.io.jev.fetch = async () => ({ status: 200, text: '{}' })
    if (reason === 'network') h.io.jev.fetch = async () => { throw new Error('private failure') }
    if (reason === 'breaker') { h.io.breaker = createBreaker(() => 0); h.io.breaker.failure(); h.io.breaker.failure(); h.io.breaker.failure() }
    if (reason === 'busy') { h.io.gate = createGate(); for (let n = 0; n < 4; n++) h.io.gate.acquire() }
    if (reason === 'timeout') {
      h.io.jev.fetch = async () => new Promise(() => {})
      h.io.jev.timer = (ms, fn) => { let cancelled = false; if (ms === 3000) void Promise.resolve().then(() => { if (!cancelled) fn() }); return () => { cancelled = true } }
    }
    h.io.log = () => { throw new Error('logging failed') }
    const asked = reason === 'http' || reason === 'malformed' || reason === 'network' || reason === 'timeout'
    expect(await ask(h, key ?? null)).toEqual({ effort: null, level: null, top: null, jevReason: reason, jevMs: asked ? 0 : null, jevTokens: null })
  }
})

test('the head is rated alone; a longer task is also rated up to the full length, and the higher level decides, at most one above the head', async () => {
  expect([TASK_CHARS, FULL_CHARS, MAX_RAISE]).toEqual([800, 4000, 1])
  const task = `Find the router. ${'detail '.repeat(400)}LAST-WORDS`
  // The full brief's answer is `full`, the head's level 0 (or `head`), with its own confidence.
  const rate = (head: string, full: string) => {
    const h = ports(), fetch = h.io.jev.fetch
    h.io.jev.fetch = async (url, init) => {
      const reply = await fetch(url, init), long = JSON.parse(init.body).state.length > TASK_CHARS
      return { ...reply, text: JSON.stringify({ answers: { reasoning: { probabilities: long ? { [full]: 0.8, '0': 0.2 } : { [head]: 1 } } }, usage: { input_tokens: long ? 900 : 300, output_tokens: 20 } }) }
    }
    return { h, choice: assessEffort(h.io, { task, home: h.io.home, root: h.io.root, keys: { env: 'test-key' } }) }
  }
  const raised = rate('1', '2')
  expect(await raised.choice).toEqual({ effort: 'high', level: 2, top: 0.8, jevReason: null, jevMs: 0, headLevel: 1, fullLevel: 2, jevTokens: { input: 1200, output: 40 } })
  const states = raised.h.requests.map(r => JSON.parse(r.body).state as string)
  expect(states.map(state => state.length)).toEqual([800, task.length])
  expect(states[0]!.startsWith('Find the router.')).toBe(true)
  expect(states[0]).not.toContain('LAST-WORDS')
  expect(states[1]).toContain('LAST-WORDS')
  // A full brief two or three levels above the head raises it by one only; both levels stay recorded.
  expect(await rate('0', '2').choice).toMatchObject({ effort: 'medium', level: 1, headLevel: 0, fullLevel: 2 })
  expect(await rate('1', '3').choice).toMatchObject({ effort: 'high', level: 2, headLevel: 1, fullLevel: 3 })
  // A full brief rated lower never lowers the head's level.
  expect(await rate('3', '1').choice).toMatchObject({ effort: 'xhigh', level: 3, top: 1, headLevel: 3, fullLevel: 1 })
})

test('a task that fits the head asks Jev once, and a failed comparison leaves the decision as the head made it', async () => {
  const short = ports()
  expect(await ask(short)).toMatchObject({ effort: 'low', fullLevel: null })
  expect(short.requests).toHaveLength(1)
  const h = ports(), task = 'x '.repeat(1000)
  const fetch = h.io.jev.fetch
  h.io.jev.fetch = async (url, init) => (JSON.parse(init.body).state.length > TASK_CHARS ? { status: 200, text: '{}' } : fetch(url, init))
  expect(await assessEffort(h.io, { task, home: h.io.home, root: h.io.root, keys: { env: 'test-key' } })).toMatchObject({ effort: 'low', level: 0, jevReason: null, headLevel: 0, fullLevel: null, jevTokens: { input: 300, output: 20 } })
})

test('assessment masks the whole task before clipping and sends only redacted task state', async () => {
  const h = ports(), key = 'private-test-key'
  const task = 'Review /home/u/private/project/file.ts ' + key.repeat(700) + ' tail'
  expect((await assessEffort(h.io, { task, home: h.io.home, root: h.io.root, keys: { option: key } })).effort).toBe('low')
  const request = h.requests[0]!, state = JSON.parse(request.body).state as string
  expect(state.length).toBeLessThanOrEqual(TASK_CHARS); expect(state).not.toContain(key); expect(state).not.toContain('/home/u/private')
  expect(request.headers.Authorization).toBe(`Bearer ${key}`)
})
