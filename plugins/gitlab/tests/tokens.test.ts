import { expect, test } from 'claude-code/testing'
import { DEFAULT_HOST_ENV, ENV_NAME, offText, parseTokens, resolveDefaultHost, resolveToken, type Off, type TokenIo } from '../hooks/tokens'

const OPTION = 'gitlab.com=glpat-personal, gitlab.example.com=glpat-work'

test('parseTokens reads host=token pairs separated by commas or whitespace, hosts case-insensitive', () => {
  expect(parseTokens(` GitLab.com=glpat-a\ngitlab.example.com:8443=glpat-b `)).toEqual({
    tokens: new Map([
      ['gitlab.com', 'glpat-a'],
      ['gitlab.example.com:8443', 'glpat-b'],
    ]),
  })
})

test('parseTokens tells an absent option from a malformed one', () => {
  expect(parseTokens(undefined)).toEqual({ off: 'no-tokens' })
  expect(parseTokens(' , ')).toEqual({ off: 'no-tokens' })
  for (const bad of [5, 'glpat-only', '=glpat-x', 'gitlab.com=', 'gitlab.com=a=b', 'a b.com=x', 'h=x,h=y', 'h/x=t']) {
    expect(parseTokens(bad), String(bad)).toEqual({ off: 'bad-tokens' })
  }
})

const io = (sources: Partial<Record<'project' | 'local', { pluginConfigs?: unknown; env?: unknown }>> = {}, env?: string): TokenIo => ({
  settings: async (source) => sources[source],
  env: async () => env,
})

test('resolveToken picks the token of the remote host only', async () => {
  expect(await resolveToken(io(), OPTION, 'gitlab.example.com')).toEqual({ token: 'glpat-work' })
  expect(await resolveToken(io(), OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  expect(await resolveToken(io(), OPTION, 'gitlab.other.org')).toEqual({ off: 'no-host' })
})

test('resolveToken refuses tokens the repository declares, and unreadable settings', async () => {
  const declared = { pluginConfigs: { 'gitlab@spider-claude-mods': { options: { tokens: 'x' } } } }
  expect(await resolveToken(io({ project: declared }), OPTION, 'gitlab.com')).toEqual({ off: 'repo-tokens' })
  expect(await resolveToken(io({ local: declared }), OPTION, 'gitlab.com')).toEqual({ off: 'repo-tokens' })
  expect(await resolveToken(io({ project: { pluginConfigs: { gitlabx: { options: { tokens: 'x' } } } } }), OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  expect(await resolveToken({ settings: () => Promise.reject(new Error('x')), env: async () => undefined }, OPTION, 'gitlab.com')).toEqual({ off: 'unreadable' })
})

test('resolveToken takes the option first, else the environment variable, and never mixes the two', async () => {
  const env = 'gitlab.com=glpat-env, gitlab.other.org=glpat-env-other'
  expect(await resolveToken(io({}, env), undefined, 'gitlab.com')).toEqual({ token: 'glpat-env' })
  expect(await resolveToken(io({}, env), '  ', 'gitlab.com')).toEqual({ token: 'glpat-env' })
  expect(await resolveToken(io({}, env), OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  expect(await resolveToken(io({}, env), OPTION, 'gitlab.other.org')).toEqual({ off: 'no-host' })
  expect(await resolveToken(io(), undefined, 'gitlab.com')).toEqual({ off: 'no-tokens' })
  expect(await resolveToken(io({}, 'glpat-only'), undefined, 'gitlab.com')).toEqual({ off: 'bad-tokens' })
})

test('resolveToken refuses a variable the repository sets in env, but only when the variable is the source in use', async () => {
  const set = { env: { [ENV_NAME]: 'gitlab.com=x' } }
  const env = 'gitlab.com=glpat-env'
  expect(await resolveToken(io({ project: set }, env), undefined, 'gitlab.com')).toEqual({ off: 'repo-env' })
  expect(await resolveToken(io({ local: set }, env), undefined, 'gitlab.com')).toEqual({ off: 'repo-env' })
  expect(await resolveToken(io({ project: set }, env), OPTION, 'gitlab.com')).toEqual({ token: 'glpat-personal' })
  const declared = { pluginConfigs: { gitlab: { options: { tokens: 'x' } } } }
  expect(await resolveToken(io({ project: declared }, env), undefined, 'gitlab.com')).toEqual({ token: 'glpat-env' })
})

test('every refusal names the option or the settings, never a token, and no-host names the host to add', () => {
  for (const off of ['no-tokens', 'bad-tokens', 'no-host', 'unreadable', 'repo-tokens', 'repo-env'] as Off[]) {
    expect(offText(off, 'gitlab.other.org')).toMatch(/tokens option|SPIDER_PLUGIN_OPTION_GITLAB_TOKENS/)
    expect(offText(off, 'gitlab.other.org')).not.toContain('glpat')
  }
  expect(offText('no-host', 'gitlab.other.org')).toContain('Add gitlab.other.org=<token>')
})

test('resolveDefaultHost takes the option first, else the variable, refused when the repository declares it or settings are unreadable', async () => {
  const variable = async () => 'gitlab.example.com'
  const repoEnv = { env: { [DEFAULT_HOST_ENV]: 'gitlab.evil.org' } }
  expect(await resolveDefaultHost(io(), 'gitlab.com', variable)).toEqual({ value: 'gitlab.com' })
  expect(await resolveDefaultHost(io({ project: repoEnv }), 'gitlab.com', variable)).toEqual({ value: 'gitlab.com' })
  const repoOption = { pluginConfigs: { 'gitlab@spider-claude-mods': { options: { defaultHost: 'gitlab.evil.org' } } } }
  expect(await resolveDefaultHost(io({ project: repoOption }), 'gitlab.evil.org', variable)).toEqual({ off: 'repo-default-host' })
  expect(await resolveDefaultHost(io({ local: repoOption }), 'gitlab.evil.org', variable)).toEqual({ off: 'repo-default-host' })
  expect(await resolveDefaultHost({ settings: () => Promise.reject(new Error('x')) }, 'gitlab.com', variable)).toEqual({ off: 'unreadable' })
  expect(await resolveDefaultHost(io(), undefined, variable)).toEqual({ value: 'gitlab.example.com' })
  expect(await resolveDefaultHost(io(), ' ', async () => undefined)).toEqual({ value: undefined })
  expect(await resolveDefaultHost(io({ project: repoEnv }), undefined, variable)).toEqual({ off: 'repo-default-host' })
  expect(await resolveDefaultHost(io({ local: repoEnv }), undefined, variable)).toEqual({ off: 'repo-default-host' })
  expect(await resolveDefaultHost({ settings: () => Promise.reject(new Error('x')) }, undefined, variable)).toEqual({ off: 'unreadable' })
  expect(offText('repo-default-host')).toBe(`The repository settings set the gitlab defaultHost option (or ${DEFAULT_HOST_ENV}), so it is not used. Set it in your user plugin options or your shell's environment instead.`)
})
