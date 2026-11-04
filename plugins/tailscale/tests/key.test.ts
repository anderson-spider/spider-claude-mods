import { expect, test } from 'claude-code/testing'
import { ENV_NAME, OFF_TEXT, checkKey, declaresOption, resolveKey, type KeyIo } from '../hooks/key'

const KEY = 'tskey-api-test'
const io = (sources: Partial<Record<'project' | 'local', { pluginConfigs?: unknown; env?: unknown }>> = {}, env?: string): KeyIo => ({
  settings: async (source) => sources[source],
  env: async () => env,
})

test('checkKey tells an absent key from a malformed one', () => {
  expect(checkKey(undefined)).toEqual({ off: 'no-key' })
  expect(checkKey('  ')).toEqual({ off: 'no-key' })
  expect(checkKey(5)).toEqual({ off: 'bad-key' })
  expect(checkKey('a b')).toEqual({ off: 'bad-key' })
  expect(checkKey('x'.repeat(513))).toEqual({ off: 'bad-key' })
  expect(checkKey(` ${KEY} `)).toEqual({ key: KEY })
})

test('declaresOption matches the plugin name or name@marketplace only', () => {
  expect(declaresOption({ 'tailscale@m': { options: { apiKey: '' } } }, 'tailscale', 'apiKey')).toBe(true)
  expect(declaresOption({ tailscalex: { options: { apiKey: 'x' } } }, 'tailscale', 'apiKey')).toBe(false)
  expect(declaresOption({ tailscale: { options: {} } }, 'tailscale', 'apiKey')).toBe(false)
})

test('resolveKey reads settings only for a valid key', async () => {
  let reads = 0
  const counting: KeyIo = { settings: async () => (reads++, undefined), env: async () => undefined }
  expect(await resolveKey(counting, undefined)).toEqual({ off: 'no-key' })
  expect(reads).toBe(0)
  expect(await resolveKey(counting, KEY)).toEqual({ key: KEY })
  expect(reads).toBe(2)
})

test('resolveKey refuses a key the repository declares, and unreadable settings', async () => {
  const declared = { pluginConfigs: { 'tailscale@spider-claude-mods': { options: { apiKey: 'r' } } } }
  expect(await resolveKey(io({ project: declared }), KEY)).toEqual({ off: 'repo-key' })
  expect(await resolveKey(io({ local: declared }), KEY)).toEqual({ off: 'repo-key' })
  expect(await resolveKey({ settings: async () => Promise.reject(new Error('x')), env: async () => undefined }, KEY)).toEqual({ off: 'unreadable' })
})

test('resolveKey takes the option first, else the environment variable, and never mixes the two', async () => {
  expect(await resolveKey(io({}, 'tskey-env'), KEY)).toEqual({ key: KEY })
  expect(await resolveKey(io({}, 'tskey-env'), '  ')).toEqual({ key: 'tskey-env' })
  expect(await resolveKey(io({}, 'tskey-env'), undefined)).toEqual({ key: 'tskey-env' })
  expect(await resolveKey(io({}, 'bad value'), undefined)).toEqual({ off: 'bad-key' })
  expect(await resolveKey(io({}, undefined), undefined)).toEqual({ off: 'no-key' })
})

test('resolveKey refuses a variable the repository sets in env, but only when the variable is the source in use', async () => {
  const env = { env: { [ENV_NAME]: 'x' } }
  expect(await resolveKey(io({ project: env }, 'tskey-env'), undefined)).toEqual({ off: 'repo-env' })
  expect(await resolveKey(io({ local: env }, 'tskey-env'), undefined)).toEqual({ off: 'repo-env' })
  expect(await resolveKey(io({ project: env }, 'tskey-env'), KEY)).toEqual({ key: KEY })
})

test('no refusal text names a value, and each one points at the option or the settings', () => {
  for (const [off, text] of Object.entries(OFF_TEXT)) expect(text).toMatch(off === 'repo-env' ? new RegExp(ENV_NAME) : /apiKey/)
  expect(OFF_TEXT['no-key']).toContain('plugin options')
})
