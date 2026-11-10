import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { holdOwnDesktop } from '../../hooks/computer-use/register'
import { known } from '../../hooks/computer-use/known'
import { UNCHECKED_OWN } from '../../hooks/computer-use/presentation'
import { denyOwn } from '../../hooks/computer-use/prompts'
import { OWN, TOOL, ran } from './helpers'

// Session end shares a 1.5 s budget with every hook: one post to the helper,
// never a kickstart or a retry. The desktop-tool guard stays closed when it fails.

const END = { reason: 'exit', sessionId: 'sess-1' } as never

const world = (on: On, options: { fetchFails?: boolean; storeFails?: boolean; envFails?: boolean } = {}) => {
  const fetched: { url: string; body: unknown; socketPath?: string }[] = []
  const runs: string[][] = []

  on('env.get', () => {
    if (options.envFails === true) {
      throw new Error('env is gone')
    }

    return { value: '/home/me' }
  })
  on('store.get', () => {
    if (options.storeFails === true) {
      throw new Error('store is gone')
    }

    return { value: undefined }
  })
  on('process.run', (_$, e) => (runs.push([...e.argv]), { value: ran('501\n') }))
  on('http.fetch', (_$, e) => {
    fetched.push({ url: e.url, body: JSON.parse((e.init?.body ?? '{}') as string), socketPath: e.init?.socketPath })

    if (options.fetchFails === true) {
      throw new Error('no socket')
    }

    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ status: 'ok', ended: [] }) } }
  })
  on('session.end', () => ({ sessionId: 'sess-1' }) as never)
  on('tool.call', { tool: OWN as never }, () => ({ result: 'clicked' }))
  on('tool.call', { tool: 'mcp__other__x' as never }, () => ({ result: 'other' }))

  return { fetched, runs }
}

test('session end sends one release to the helper and starts nothing', async ($, on) => {
  const { fetched, runs } = world(on)

  await $.session.end(END)

  expect(fetched).toEqual([{ url: 'http://codex-cu/release', body: { caller: 'sess-1' }, socketPath: '/home/me/.claude/mcp/codex-cu/run/helper.sock' }])
  expect(runs).toEqual([])
})

test('session end with an unreachable helper makes one post, no kickstart, no poll, and does not throw', async ($, on) => {
  const { fetched, runs } = world(on, { fetchFails: true })

  await expect($.session.end(END)).resolves.toBeDefined()

  expect(fetched).toHaveLength(1)
  expect(runs).toEqual([])
})

test('session end swallows a failure of the home read and still reaches core', async ($, on) => {
  const { fetched, runs } = world(on, { envFails: true })

  await expect($.session.end(END)).resolves.toBeDefined()

  expect(fetched).toEqual([])
  expect(runs).toEqual([])
})

test('a guard whose switch read fails still refuses the own desktop tool, saying it could not check, and passes the others', async ($, on) => {
  world(on, { storeFails: true })

  expect((await $.tool.call({ tool: OWN } as never)).deny).toBe(UNCHECKED_OWN)
  expect(await $.tool.call({ tool: 'mcp__other__x' } as never)).toMatchObject({ result: 'other' })
})

const caught = (called: boolean, kind: 'throw' | 'timeout' | 're-entry') =>
  Object.assign(async (e: { tool: string }) => ({ passed: e.tool }), { called, error: { kind, budget: 1000 } as const })

test('the guard catch denies an own desktop tool and passes the bridge, other tools and a hook that already answered', async () => {
  const next = caught(false, 'throw')
  const answered = caught(true, 'throw')
  const $ = undefined as never
  Object.assign(known, { mac: true, enabled: true })

  expect(holdOwnDesktop($, { tool: OWN }, next)).toEqual({ deny: denyOwn(TOOL) })
  expect(holdOwnDesktop($, { tool: 'enable__mcp__remote-devices__computer' }, next)).toEqual({ deny: denyOwn(TOOL) })
  expect(holdOwnDesktop($, { tool: OWN }, caught(false, 'timeout'))).toEqual({ deny: denyOwn(TOOL) })
  await expect(holdOwnDesktop($, { tool: 'mcp__other__x' }, next)).resolves.toEqual({ passed: 'mcp__other__x' })
  await expect(holdOwnDesktop($, { tool: TOOL }, next)).resolves.toEqual({ passed: TOOL })
  await expect(holdOwnDesktop($, { tool: OWN }, answered)).resolves.toEqual({ passed: OWN })
})

test('the guard catch on a re-entry refuses an own desktop tool with neutral text, and still passes the others', async () => {
  const $ = undefined as never
  Object.assign(known, { mac: true, enabled: true })
  const reentry = caught(false, 're-entry')
  const denied = holdOwnDesktop($, { tool: OWN }, reentry)

  expect(denied).toEqual({ deny: UNCHECKED_OWN })
  expect(UNCHECKED_OWN).not.toMatch(/Codex computer use is on/)
  expect(UNCHECKED_OWN).toMatch(/own desktop tool/)
  await expect(holdOwnDesktop($, { tool: 'mcp__other__x' }, reentry)).resolves.toEqual({ passed: 'mcp__other__x' })
  await expect(holdOwnDesktop($, { tool: TOOL }, reentry)).resolves.toEqual({ passed: TOOL })
})

test('the guard catch lets the own desktop tool run off macOS or with the switch last seen off, and cannot vouch for a switch never read', async () => {
  const $ = undefined as never
  const next = caught(false, 'throw')

  Object.assign(known, { mac: false, enabled: true })
  await expect(holdOwnDesktop($, { tool: OWN }, next)).resolves.toEqual({ passed: OWN })
  Object.assign(known, { mac: true, enabled: false })
  await expect(holdOwnDesktop($, { tool: OWN }, next)).resolves.toEqual({ passed: OWN })
  Object.assign(known, { mac: true, enabled: undefined })
  expect(holdOwnDesktop($, { tool: OWN }, next)).toEqual({ deny: UNCHECKED_OWN })
  Object.assign(known, { mac: undefined, enabled: undefined })
})
