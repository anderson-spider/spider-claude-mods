import { expect, test } from 'claude-code/testing'
import { checkToken, checkUrl, resolveAccess, type AccessIo, type EnvName, type Settings } from '../hooks/access'

const URL_A = 'https://sonar.example.com'
const URL_B = 'https://other.example.com'

function io(opts: { env?: Partial<Record<EnvName, string>>; user?: Settings; project?: Settings; local?: Settings; fail?: boolean } = {}): AccessIo {
  return {
    env: async () => opts.env ?? {},
    settings: async (source) => {
      if (opts.fail) throw new Error('unreadable')
      return source === 'user' ? opts.user : source === 'project' ? opts.project : opts.local
    },
  }
}

test('the url and token options come first, then SONARQUBE_URL/SONARQUBE_TOKEN, then SONAR_URL/SONAR_TOKEN', async () => {
  const env = { SONARQUBE_URL: URL_A, SONARQUBE_TOKEN: 'env-a', SONAR_URL: URL_B, SONAR_TOKEN: 'env-b' }

  expect(await resolveAccess(io({ env }), { url: 'https://opt.example.com/', token: 'opt' })).toEqual({ base: 'https://opt.example.com', token: 'opt', source: 'options' })
  expect(await resolveAccess(io({ env }), {})).toEqual({ base: URL_A, token: 'env-a', source: 'SONARQUBE_*' })
  expect(await resolveAccess(io({ env: { SONAR_URL: URL_B, SONAR_TOKEN: 'env-b' } }), { url: '', token: '  ' })).toEqual({ base: URL_B, token: 'env-b', source: 'SONAR_*' })
})

test('a source counts only whole: a url never gets the token of another source', async () => {
  expect(await resolveAccess(io({ env: { SONARQUBE_URL: URL_A, SONAR_TOKEN: 'b' } }), {})).toEqual({ off: 'none' })
  expect(await resolveAccess(io({ env: { SONARQUBE_URL: URL_A, SONAR_URL: URL_B, SONAR_TOKEN: 'b' } }), {})).toEqual({ base: URL_B, token: 'b', source: 'SONAR_*' })
  expect(await resolveAccess(io({ env: { SONAR_URL: URL_B, SONAR_TOKEN: 'b' } }), { url: URL_A })).toEqual({ off: 'half-option' })
  expect(await resolveAccess(io({ env: { SONAR_URL: URL_B, SONAR_TOKEN: 'b' } }), { token: 'opt' })).toEqual({ off: 'half-option' })
  expect(await resolveAccess(io(), {})).toEqual({ off: 'none' })
})

test('only https urls with no credentials, query or fragment pass; a context path is kept', () => {
  expect(checkUrl('https://sonar.example.com')).toBe('https://sonar.example.com')
  expect(checkUrl(' https://sonar.example.com:9443/sonar/ ')).toBe('https://sonar.example.com:9443/sonar')
  for (const bad of ['http://sonar.example.com', 'https://u:p@sonar.example.com', 'https://sonar.example.com/?a=1', 'https://sonar.example.com#x', 'sonar.example.com', 42]) {
    expect(checkUrl(bad), String(bad)).toBeUndefined()
  }
})

test('a token with spaces or control characters, or that is not a string, is refused', async () => {
  expect(checkToken(' squ_abc ')).toBe('squ_abc')
  expect(checkToken('a b')).toBeUndefined()
  expect(checkToken('a\nb')).toBeUndefined()
  expect(await resolveAccess(io(), { url: URL_A, token: 'a b' })).toEqual({ off: 'bad-token' })
  expect(await resolveAccess(io(), { url: 'http://sonar.example.com', token: 't' })).toEqual({ off: 'bad-url' })
  expect(await resolveAccess(io({ env: { SONAR_URL: 'http://x', SONAR_TOKEN: 't' } }), {})).toEqual({ off: 'bad-url' })
})

test('options the repository settings chose refuse the call, unless the user settings give the same value', async () => {
  const configs = (url: string) => ({ pluginConfigs: { 'sonarqube@spider-claude-mods': { options: { url } } } })

  expect(await resolveAccess(io({ project: configs(URL_B) }), { url: URL_B, token: 't' })).toEqual({ off: 'repo-option' })
  expect(await resolveAccess(io({ local: configs(URL_B) }), { url: URL_B, token: 't' })).toEqual({ off: 'repo-option' })
  expect(await resolveAccess(io({ user: configs(URL_A), project: configs(URL_A) }), { url: URL_A, token: 't' })).toEqual({ base: URL_A, token: 't', source: 'options' })
})

test('environment variables the repository settings set refuse the call, unless the user settings set the same value', async () => {
  const env = { SONAR_URL: URL_B, SONAR_TOKEN: 't' }

  expect(await resolveAccess(io({ env, project: { env: { SONAR_URL: URL_B } } }), {})).toEqual({ off: 'repo-env' })
  expect(await resolveAccess(io({ env, local: { env: { SONAR_TOKEN: 't' } } }), {})).toEqual({ off: 'repo-env' })
  expect(await resolveAccess(io({ env, user: { env: { SONAR_URL: URL_B } }, project: { env: { SONAR_URL: URL_B } } }), {})).toEqual({ base: URL_B, token: 't', source: 'SONAR_*' })
  // a variable of the pair not in use is no choice of this call
  expect(await resolveAccess(io({ env, project: { env: { SONARQUBE_URL: URL_A } } }), {})).toEqual({ base: URL_B, token: 't', source: 'SONAR_*' })
})

test('settings that cannot be read refuse the call', async () => {
  expect(await resolveAccess(io({ fail: true }), { url: URL_A, token: 't' })).toEqual({ off: 'unreadable' })
  expect(await resolveAccess(io({ fail: true, env: { SONAR_URL: URL_A, SONAR_TOKEN: 't' } }), {})).toEqual({ off: 'unreadable' })
})
