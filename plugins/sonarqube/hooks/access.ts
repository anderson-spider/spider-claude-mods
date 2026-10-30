// Where the SonarQube server and its token come from. Pure: the settings and environment reads are injected.
// The `url` and `token` options come first; with neither set, the SONARQUBE_URL/SONARQUBE_TOKEN pair, then
// SONAR_URL/SONAR_TOKEN. A source counts only whole: a url from one source never receives the token of another.
// A value the repository's own settings (project or local) chose, as a plugin option or in `env`, refuses the call: a
// repository that set the url could send the user's token to a host it controls. The same value as the user's settings
// give is not a choice of the repository: with Claude opened in the home folder, the project settings are the user's own
// ~/.claude/settings.json. Settings that cannot be read refuse the call as well. No message carries a value.

export const ENV_NAMES = ['SONARQUBE_URL', 'SONARQUBE_TOKEN', 'SONAR_URL', 'SONAR_TOKEN'] as const
export type EnvName = (typeof ENV_NAMES)[number]

/** The environment pairs, in the order they are tried. */
const ENV_PAIRS = [
  { url: 'SONARQUBE_URL', token: 'SONARQUBE_TOKEN' },
  { url: 'SONAR_URL', token: 'SONAR_TOKEN' },
] as const

const OPTION_NAMES = ['url', 'token'] as const

export type Settings = { pluginConfigs?: unknown; env?: unknown }

export type AccessIo = {
  /** One settings source's `pluginConfigs` and `env`; rejects when it cannot be read. */
  settings: (source: 'user' | 'project' | 'local') => Promise<Settings | undefined>
  /** The process environment's value of each name the plugin reads. */
  env: () => Promise<Partial<Record<EnvName, string>>>
}

export type Off = 'none' | 'half-option' | 'bad-token' | 'bad-url' | 'unreadable' | 'repo-option' | 'repo-env'

const CONFIGURE = 'the plugin options (/plugin, sonarqube, configure)'

/** What each refusal tells the user: where to set the url and token, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  none: `No SonarQube server is configured. Set the sonarqube url and token in ${CONFIGURE}, or export SONARQUBE_URL and SONARQUBE_TOKEN (or SONAR_URL and SONAR_TOKEN) before starting Claude.`,
  'half-option': `Only one of the sonarqube url and token options is set. Set both in ${CONFIGURE}, or clear both to use the environment variables.`,
  'bad-token': 'The SonarQube token is not a valid token (printable characters, no spaces). Set it again.',
  'bad-url':
    'The SonarQube url must be an https address with no user, query or fragment, such as https://sonarqube.example.com (a path such as /sonar is kept). Set it again.',
  unreadable: 'The project or local settings could not be read, so the SonarQube url and token are not used.',
  'repo-option':
    'The repository settings declare the sonarqube url or token option, so neither is used. Set them in your user plugin options instead.',
  'repo-env':
    "The repository settings set the SonarQube url or token environment variable, so they are not used. Set them in your user plugin options or your shell's environment instead.",
}

/** Printable ASCII with no space, so the `Authorization` header cannot be broken by what was pasted. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/

/** Present: a string with something but spaces. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

export function checkToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  return TOKEN_SHAPE.test(token) ? token : undefined
}

/**
 * The server's base (`https://host[:port][/context]`, no trailing slash), or undefined. Only https, so the token never
 * travels in clear text; no credentials, query or fragment; a context path is kept, since SonarQube may run under one.
 */
export function checkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#')) {
    return undefined
  }
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** The values a settings source's `pluginConfigs` give this plugin for `options`, under its name or name@marketplace. */
export function declaredOptions(configs: unknown, plugin: string, options: readonly string[]): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>()
  if (!configs || typeof configs !== 'object') return found
  for (const [name, value] of Object.entries(configs)) {
    if (name !== plugin && !name.startsWith(`${plugin}@`)) continue
    const declared = (value as { options?: unknown } | null | undefined)?.options
    if (!declared || typeof declared !== 'object') continue
    for (const option of options) {
      if (Object.hasOwn(declared, option)) found.set(option, [...(found.get(option) ?? []), (declared as Record<string, unknown>)[option]])
    }
  }
  return found
}

/** The values a settings source's `env` gives `names`. */
export function declaredEnv(env: unknown, names: readonly string[]): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>()
  if (!env || typeof env !== 'object') return found
  for (const name of names) {
    if (Object.hasOwn(env, name)) found.set(name, [(env as Record<string, unknown>)[name]])
  }
  return found
}

/** Whether `repo` declares a value that `user` does not declare: a value only the repository chose. */
export function repoChose(repo: Map<string, unknown[]>, user: Map<string, unknown[]>): boolean {
  for (const [name, values] of repo) {
    const own = new Set((user.get(name) ?? []).map((v) => JSON.stringify(v)))
    if (values.some((v) => !own.has(JSON.stringify(v)))) return true
  }
  return false
}

export type Source = 'options' | 'SONARQUBE_*' | 'SONAR_*'
export type Access = { base: string; token: string; source: Source; off?: undefined } | { off: Off }

type Picked = { url: unknown; token: unknown; source: Source; names: readonly string[]; off?: undefined } | { off: 'none' | 'half-option' }

/** The url and token of the first source that gives both, or why none does. */
function pick(options: { url?: unknown; token?: unknown }, env: Partial<Record<EnvName, string>>): Picked {
  if (isSet(options.url) || isSet(options.token)) {
    if (!isSet(options.url) || !isSet(options.token)) return { off: 'half-option' }
    return { url: options.url, token: options.token, source: 'options', names: OPTION_NAMES }
  }
  for (const pair of ENV_PAIRS) {
    if (isSet(env[pair.url]) && isSet(env[pair.token])) {
      const source = pair.url === 'SONARQUBE_URL' ? 'SONARQUBE_*' : 'SONAR_*'
      return { url: env[pair.url], token: env[pair.token], source, names: [pair.url, pair.token] }
    }
  }
  return { off: 'none' }
}

/** The base and token to use, or why there are none. Settings are read only for a whole, valid source. */
export async function resolveAccess(io: AccessIo, options: { url?: unknown; token?: unknown }): Promise<Access> {
  const picked = pick(options, await io.env())
  if (picked.off !== undefined) return { off: picked.off }
  const token = checkToken(picked.token)
  if (token === undefined) return { off: 'bad-token' }
  const base = checkUrl(picked.url)
  if (base === undefined) return { off: 'bad-url' }
  const declared = (settings: Settings | undefined) =>
    picked.source === 'options' ? declaredOptions(settings?.pluginConfigs, 'sonarqube', picked.names) : declaredEnv(settings?.env, picked.names)
  let chosen = false
  try {
    const user = declared(await io.settings('user'))
    for (const source of ['project', 'local'] as const) {
      if (repoChose(declared(await io.settings(source)), user)) chosen = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  if (chosen) return { off: picked.source === 'options' ? 'repo-option' : 'repo-env' }
  return { base, token, source: picked.source }
}
