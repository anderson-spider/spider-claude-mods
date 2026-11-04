import { expect, test } from 'claude-code/testing'
import { ENV_KEY, ENV_URL, OFF_TEXT, checkKey, checkUrl, declaredOptions, repoChose, resolveAccess, type AccessIo } from '../hooks/access'

const KEY = '1|coolify-test-token'
const URL_OPTION = 'https://coolify.example.com'
const io = (sources: Partial<Record<'user' | 'project' | 'local', { pluginConfigs?: unknown; env?: unknown }>> = {}, env: { url?: string; apiKey?: string } = {}): AccessIo => ({
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

test('checkUrl turns an https origin into its API base', () => {
  expect(checkUrl(URL_OPTION)).toEqual({ base: 'https://coolify.example.com/api/v1' })
  expect(checkUrl(' https://coolify.example.com/ ')).toEqual({ base: 'https://coolify.example.com/api/v1' })
  expect(checkUrl('https://coolify.example.com/api/v1/')).toEqual({ base: 'https://coolify.example.com/api/v1' })
  expect(checkUrl('https://Coolify.Example.com:8443')).toEqual({ base: 'https://coolify.example.com:8443/api/v1' })
  expect(checkUrl('https://app.coolify.io')).toEqual({ base: 'https://app.coolify.io/api/v1' })
})

test('checkUrl refuses a missing url, plain http, credentials, another path, a query or a fragment', () => {
  expect(checkUrl(undefined)).toEqual({ off: 'no-url' })
  expect(checkUrl(' ')).toEqual({ off: 'no-url' })
  for (const bad of [
    5,
    'coolify.example.com',
    'http://coolify.example.com',
    'ftp://coolify.example.com',
    'https://user:pass@coolify.example.com',
    'https://user@coolify.example.com',
    'https://coolify.example.com/other',
    'https://coolify.example.com/api/v2',
    'https://coolify.example.com/?x=1',
    'https://coolify.example.com/?',
    'https://coolify.example.com/#x',
    'https://',
  ]) {
    expect(checkUrl(bad), String(bad)).toEqual({ off: 'bad-url' })
  }
})

test('declaredOptions collects the values under the plugin name or name@marketplace only', () => {
  const found = declaredOptions(
    { 'coolify@m': { options: { apiKey: '' } }, coolify: { options: { url: 'https://a' } }, coolifyx: { options: { url: 'x' } }, other: 1 },
    'coolify',
    ['url', 'apiKey'],
  )
  expect([...found]).toEqual([['apiKey', ['']], ['url', ['https://a']]])
  expect(declaredOptions({ coolify: { options: { other: 1 } } }, 'coolify', ['url']).size).toBe(0)
  expect(declaredOptions(undefined, 'coolify', ['url']).size).toBe(0)
})

test('repoChose is true only for a value the user settings do not declare', () => {
  const user = new Map([['url', ['https://mine']]])
  expect(repoChose(new Map(), user)).toBe(false)
  expect(repoChose(new Map([['url', ['https://mine']]]), user)).toBe(false)
  expect(repoChose(new Map([['url', ['https://evil']]]), user)).toBe(true)
  expect(repoChose(new Map([['url', ['https://mine', 'https://evil']]]), user)).toBe(true)
  expect(repoChose(new Map([['apiKey', ['k']]]), user)).toBe(true)
})

test('resolveAccess reads settings only when both options are valid', async () => {
  let reads = 0
  const counting: AccessIo = { settings: async () => (reads++, undefined), env: async () => ({}) }
  expect(await resolveAccess(counting, { url: URL_OPTION })).toEqual({ off: 'no-key' })
  expect(await resolveAccess(counting, { apiKey: KEY })).toEqual({ off: 'no-url' })
  expect(await resolveAccess(counting, { apiKey: KEY, url: 'http://coolify.example.com' })).toEqual({ off: 'bad-url' })
  expect(reads).toBe(0)
  expect(await resolveAccess(counting, { apiKey: KEY, url: URL_OPTION })).toEqual({ key: KEY, base: 'https://coolify.example.com/api/v1' })
  expect(reads).toBe(3)
})

test('resolveAccess refuses a url or key the repository declares, and unreadable settings', async () => {
  const options = { apiKey: KEY, url: URL_OPTION }
  const url = { pluginConfigs: { 'coolify@spider-claude-mods': { options: { url: 'https://evil.com' } } } }
  const key = { pluginConfigs: { coolify: { options: { apiKey: 'r' } } } }
  expect(await resolveAccess(io({ project: url }), options)).toEqual({ off: 'repo-option' })
  expect(await resolveAccess(io({ local: key }), options)).toEqual({ off: 'repo-option' })
  expect(await resolveAccess({ settings: async () => Promise.reject(new Error('x')), env: async () => ({}) }, options)).toEqual({ off: 'unreadable' })
  expect(await resolveAccess({ settings: async (s) => (s === 'user' ? Promise.reject(new Error('x')) : undefined), env: async () => ({}) }, options)).toEqual({ off: 'unreadable' })
})

test('resolveAccess accepts project settings that repeat the user settings, as with Claude opened in the home folder', async () => {
  const options = { apiKey: KEY, url: URL_OPTION }
  const home = { pluginConfigs: { 'coolify@spider-claude-mods': { options: { url: URL_OPTION } } } }
  const expected = { key: KEY, base: 'https://coolify.example.com/api/v1' }
  expect(await resolveAccess(io({ user: home, project: home }), options)).toEqual(expected)
  const evil = { pluginConfigs: { coolify: { options: { url: 'https://evil.example' } } } }
  expect(await resolveAccess(io({ user: home, project: evil }), options)).toEqual({ off: 'repo-option' })
  const key = { pluginConfigs: { coolify: { options: { url: URL_OPTION, apiKey: 'repo-key' } } } }
  expect(await resolveAccess(io({ user: home, local: key }), options)).toEqual({ off: 'repo-option' })
})

test('no refusal text names a value, and each one points at an option or the settings', () => {
  for (const text of Object.values(OFF_TEXT)) expect(text).toMatch(/url|apiKey/)
  expect(OFF_TEXT['no-key']).toContain('plugin options')
  expect(OFF_TEXT['no-url']).toContain('plugin options')
})

test('resolveAccess takes the options first, else the environment variables, and never mixes the two', async () => {
  const env = { url: 'https://env.example.com', apiKey: 'env-key' }
  expect(await resolveAccess(io({}, env), { url: URL_OPTION, apiKey: KEY })).toEqual({ key: KEY, base: 'https://coolify.example.com/api/v1' })
  expect(await resolveAccess(io({}, env), {})).toEqual({ key: 'env-key', base: 'https://env.example.com/api/v1' })
  expect(await resolveAccess(io({}, env), { url: ' ', apiKey: ' ' })).toEqual({ key: 'env-key', base: 'https://env.example.com/api/v1' })
  expect(await resolveAccess(io({}, env), { url: URL_OPTION })).toEqual({ off: 'no-key' })
  expect(await resolveAccess(io({}, { url: 'https://env.example.com' }), {})).toEqual({ off: 'no-key' })
  expect(await resolveAccess(io({}, { apiKey: 'env-key' }), {})).toEqual({ off: 'no-url' })
})

test('resolveAccess refuses a variable the repository sets in env, unless the user sets the same value', async () => {
  const env = { url: 'https://env.example.com', apiKey: 'env-key' }
  const evil = { env: { [ENV_URL]: 'https://evil.example.com' } }
  expect(await resolveAccess(io({ project: evil }, env), {})).toEqual({ off: 'repo-env' })
  expect(await resolveAccess(io({ local: { env: { [ENV_KEY]: 'k' } } }, env), {})).toEqual({ off: 'repo-env' })
  expect(await resolveAccess(io({ user: evil, project: evil }, env), {})).toEqual({ key: 'env-key', base: 'https://env.example.com/api/v1' })
  expect(await resolveAccess(io({ project: evil }, env), { url: URL_OPTION, apiKey: KEY })).toEqual({ key: KEY, base: 'https://coolify.example.com/api/v1' })
})
