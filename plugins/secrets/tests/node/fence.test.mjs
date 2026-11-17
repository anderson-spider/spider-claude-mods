// The fence hook and the server's owner-only files, on Node, against a real temporary home folder.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { decide, liveValues } from '../../fence/main.mjs'
import { nodeDeps } from '../../server/node.mjs'

const VALUE = 'cf-token-0123456789'
const MAIN = fileURLToPath(new URL('../../fence/main.mjs', import.meta.url))

/**
 * A home folder with one live and one expired secret and a stray file, removed after `run`.
 * @param {(home: string, dir: string) => Promise<void> | void} run
 */
async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'secrets-fence-'))
  const dir = join(home, '.claude', 'secrets')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CF_TOKEN.0123456789abcdef'), VALUE)
  writeFileSync(join(dir, 'OLD.fedcba9876543210'), 'old-token-0123456789')
  const dayAgo = (Date.now() - 25 * 60 * 60 * 1000) / 1000
  utimesSync(join(dir, 'OLD.fedcba9876543210'), dayAgo, dayAgo)
  writeFileSync(join(dir, 'stray.txt'), 'not-a-secret-0123')
  try {
    await run(home, dir)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** @type {(tool: string, input: Record<string, unknown>) => string} */
const hook = (tool, input) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: '/proj' })

test('liveValues reads only the files the plugin wrote that are short of their day', async () => {
  await withHome(async (_home, dir) => {
    assert.deepEqual(await liveValues(dir, Date.now()), [VALUE])
    assert.deepEqual(await liveValues(join(dir, 'missing'), Date.now()), [])
  })
})

test('decide denies the folder and a carried value with the deny text, and lets the rest go on', async () => {
  await withHome(async (home, dir) => {
    const env = { home }
    const file = join(dir, 'CF_TOKEN.0123456789abcdef')
    const denied = JSON.parse((await decide(hook('Read', { file_path: file }), env, Date.now())) ?? '{}')
    assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /The secrets folder is private/)

    const sent = (await decide(hook('SendMessage', { to: 'helper', message: `token ${VALUE}` }), env, Date.now())) ?? ''
    assert.match(sent, /it carries the value of a saved secret/)
    assert.ok(!sent.includes(VALUE))

    assert.equal(await decide(hook('Bash', { command: `TOKEN="$(cat ${file})" wrangler deploy` }), env, Date.now()), undefined)
    assert.equal(await decide(hook('Read', { file_path: '/proj/README.md' }), env, Date.now()), undefined)
    // an expired file's value is no longer live
    assert.equal(await decide(hook('SendMessage', { message: 'old-token-0123456789' }), env, Date.now()), undefined)
  })
})

test('the hook run by node prints a deny for a call into the folder and nothing otherwise, also for input it cannot read', async () => {
  await withHome((home, dir) => {
    const run = (/** @type {string} */ stdin) => spawnSync(process.execPath, [MAIN], { input: stdin, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' })

    const denied = run(hook('Bash', { command: `cat ${join(dir, 'CF_TOKEN.0123456789abcdef')}` }))
    assert.equal(denied.status, 0)
    assert.match(denied.stdout, /"permissionDecision":"deny"/)

    const allowed = run(hook('Bash', { command: 'ls /proj' }))
    assert.equal(allowed.status, 0)
    assert.equal(allowed.stdout, '')

    const garbled = run('not json')
    assert.equal(garbled.status, 0)
    assert.equal(garbled.stdout, '')
  })
})

test('the server writes a request owner-only, in owner-only folders it makes, and shows it only whole', async () => {
  await withHome(async (home) => {
    const deps = nodeDeps({ home }, 4242)
    const queue = join(home, '.claude', 'secrets', '.requests', '4242')
    const file = join(queue, '0123456789abcdef.json')

    await deps.write(queue, '0123456789abcdef.json', '{"name":"X"}')

    assert.equal(statSync(queue).mode & 0o777, 0o700)
    assert.equal(statSync(join(queue, '..')).mode & 0o777, 0o700)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(await deps.read(file), '{"name":"X"}')
    assert.equal(await deps.read(`${file}.partial`), undefined)
    assert.equal(await deps.remove(file), true)
    assert.equal(await deps.remove(file), false)
  })
})
