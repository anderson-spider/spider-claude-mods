// `test` and the `expect` matchers these tests use, on node:test and node:assert, so the tests read as they did under
// the hooks engine's runner. `toEqual` ignores properties that are undefined, as that runner did.
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'

export const test = (name: string, run: () => unknown): void => {
  nodeTest(name, async () => { await run() })
}

/** Plain data with the undefined properties dropped, so `{ a: 1, b: undefined }` equals `{ a: 1 }`. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain)
  if (value instanceof Error || value instanceof RegExp || value instanceof Date || value instanceof Map || value instanceof Set) return value
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

/** Whether `actual` holds every property of `expected`, recursively; arrays match element by element. */
function holds(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => holds(actual[i], e))
  if (expected instanceof RegExp) return actual instanceof RegExp ? actual.source === expected.source : false
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false
    return Object.entries(expected).every(([k, e]) => holds((actual as Record<string, unknown>)[k], e))
  }
  return Object.is(actual, expected)
}

function thrown(err: unknown, expected?: string | RegExp | (new (...args: never[]) => Error)): boolean {
  const message = err instanceof Error ? err.message : String(err)
  if (expected === undefined) return true
  if (typeof expected === 'string') return message.includes(expected)
  if (expected instanceof RegExp) return expected.test(message)
  return err instanceof expected
}

type Matchers = {
  toBe: (expected: unknown) => void
  toEqual: (expected: unknown) => void
  toMatchObject: (expected: unknown) => void
  toContain: (expected: unknown) => void
  toMatch: (expected: string | RegExp) => void
  toHaveLength: (length: number) => void
  toBeUndefined: () => void
  toBeNull: () => void
  toBeGreaterThan: (n: number) => void
  toBeLessThan: (n: number) => void
  toBeLessThanOrEqual: (n: number) => void
  toThrow: (expected?: string | RegExp | (new (...args: never[]) => Error)) => void
}

function matchers(actual: unknown, negate: boolean, label?: string): Matchers {
  const check = (ok: boolean, what: string, expected?: unknown) => {
    if (ok !== negate) return
    const shown = (v: unknown) => { try { return JSON.stringify(v) } catch { return String(v) } }
    assert.fail(`${label ? `${label}: ` : ''}expected ${shown(actual)} ${negate ? 'not ' : ''}${what}${expected === undefined ? '' : ` ${shown(expected)}`}`)
  }
  return {
    toBe: expected => check(Object.is(actual, expected), 'to be', expected),
    toEqual: expected => {
      let ok = true
      try { assert.deepStrictEqual(plain(actual), plain(expected)) } catch { ok = false }
      check(ok, 'to equal', expected)
    },
    toMatchObject: expected => check(holds(actual, expected), 'to match object', expected),
    toContain: expected => check(typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.includes(expected), 'to contain', expected),
    toMatch: expected => check(typeof actual === 'string' && (typeof expected === 'string' ? actual.includes(expected) : expected.test(actual)), 'to match', String(expected)),
    toHaveLength: length => check((actual as { length?: unknown } | null)?.length === length, 'to have length', length),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeGreaterThan: n => check(typeof actual === 'number' && actual > n, 'to be greater than', n),
    toBeLessThan: n => check(typeof actual === 'number' && actual < n, 'to be less than', n),
    toBeLessThanOrEqual: n => check(typeof actual === 'number' && actual <= n, 'to be at most', n),
    toThrow: expected => {
      let ok = false
      try { (actual as () => unknown)() } catch (err) { ok = thrown(err, expected) }
      check(ok, 'to throw', expected === undefined ? undefined : String(expected))
    },
  }
}

type Rejects = { toThrow: (expected?: string | RegExp | (new (...args: never[]) => Error)) => Promise<void> }

export function expect(actual: unknown, label?: string): Matchers & { not: Matchers; rejects: Rejects } {
  return {
    ...matchers(actual, false, label),
    not: matchers(actual, true, label),
    rejects: {
      toThrow: async expected => {
        let err: unknown
        let threw = false
        try { await actual } catch (e) { threw = true; err = e }
        if (!threw) assert.fail(`${label ? `${label}: ` : ''}expected the promise to reject`)
        if (!thrown(err, expected)) assert.fail(`${label ? `${label}: ` : ''}rejected with ${String(err)}, not ${String(expected)}`)
      },
    },
  }
}
