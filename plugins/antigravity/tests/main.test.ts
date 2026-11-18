import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { EXIT, cli, type Io } from '../cli/main.ts'
import { fakeAgyDir } from './fake-agy.ts'

const NOW = Date.parse('2026-11-18T11:55:00Z')

async function harness(extra: NodeJS.ProcessEnv = {}) {
  const dir = await fakeAgyDir()
  const out: string[] = []
  const err: string[] = []
  const io: Io = { out: text => void out.push(text), err: text => void err.push(text), now: () => NOW, env: { PATH: `${dir}:/usr/bin:/bin`, HOME: '/nonexistent', XDG_STATE_HOME: await mkdtemp(join(tmpdir(), 'antigravity-state-')), ...extra } }
  return { io, out, err }
}

test('doctor reports every check and passes with a signed-in agy', async () => {
  const { io, out } = await harness()
  assert.equal(await cli(['doctor'], io), EXIT.ok)
  const text = out.join('\n')
  for (const line of [/^ok {2}agy: .*\/agy$/m, /^ok {2}version: 1\.5\.11$/m, /^ok {2}sign-in: 2 Gemini models: gemini-4-argon-high, gemini-3\.8-flash-low$/m, /^ok {2}agy home: .*\(private;/m, /^ok {2}quota: Gemini Models · weekly: 50% left, resets in about/m]) assert.match(text, line)
})

test('doctor fails as unavailable when agy is signed out or missing', async () => {
  const signedOut = await harness({ FAKE_AGY_MODE: 'signed-out' })
  assert.equal(await cli(['doctor'], signedOut.io), EXIT.unavailable)
  assert.match(signedOut.out.join('\n'), /^FAIL sign-in: agy models listed no model: not signed in$/m)
  const missing = await harness({ PATH: '/nonexistent' })
  assert.equal(await cli(['doctor', '--json'], missing.io), EXIT.unavailable)
  assert.equal(JSON.parse(missing.out.join('')).ok, false)
})

test('models lists Gemini first and marks third-party models', async () => {
  const { io, out } = await harness()
  assert.equal(await cli(['models'], io), EXIT.ok)
  assert.deepEqual(out.join('\n').split('\n'), ['gemini-4-argon-high  Gemini 4 Argon (High)', 'gemini-3.8-flash-low  Gemini 3.8 Flash (Low)', 'claude-opus-5-5-high  Claude Opus 5.5 (High)  (third party)'])
})

test('quota prints each window with its reset, and JSON on --json', async () => {
  const { io, out } = await harness()
  assert.equal(await cli(['quota'], io), EXIT.ok)
  assert.match(out.join('\n'), /^Gemini Models · 5-hour: 25% left, resets in about 2 h 5 min \(at 2026-11-18 14:00 UTC\)$/m)
  const json = await harness()
  assert.equal(await cli(['quota', '--json'], json.io), EXIT.ok)
  assert.equal(JSON.parse(json.out.join('')).length, 5)
})

test('bad usage exits 2 with the usage text', async () => {
  for (const argv of [[], ['bogus'], ['doctor', 'extra'], ['doctor', '--nope']]) {
    const { io, out, err } = await harness()
    assert.equal(await cli(argv, io), EXIT.usage, argv.join(' '))
    assert.match([...out, ...err].join('\n'), /Usage: antigravity-delegate/)
  }
})

test('the bin/ launcher runs the CLI under Node', async () => {
  const { stdout } = await promisify(execFile)(join(import.meta.dirname, '..', 'bin', 'antigravity-delegate'), ['--help'])
  assert.match(stdout, /^Usage: antigravity-delegate <command>/)
})

test('an unset plugin option, empty or left as its placeholder, counts as not given', async () => {
  const { io, out } = await harness()
  assert.equal(await cli(['models', '--agy-path', ''], io), EXIT.ok)
  assert.equal(await cli(['models', '--agy-path', '${user_config.agyPath}'], io), EXIT.ok)
  assert.equal(out.length, 2)
})
