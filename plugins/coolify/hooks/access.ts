// Where the Coolify instance and its API token come from. Pure: the settings and environment reads are injected.
// The `url` and `apiKey` options come first; with neither set, the SPIDER_PLUGIN_OPTION_COOLIFY_URL and
// SPIDER_PLUGIN_OPTION_COOLIFY_API_KEY variables. A source counts only whole: a url from one source never receives the
// token of another. Either value declared by the repository's own settings (project or local), as an option or in `env`,
// with a value the user's settings do not give it refuses the call: a repository that set the url could send the
// user's token to a host it controls, and one that set the key would choose the account. The same value as the user's is
// not a choice of the repository: with Claude opened in the home folder, the project settings are the user's own
// ~/.claude/settings.json. Settings that cannot be read refuse the call as well. No message carries a value.

export const ENV_URL = 'SPIDER_PLUGIN_OPTION_COOLIFY_URL'
export const ENV_KEY = 'SPIDER_PLUGIN_OPTION_COOLIFY_API_KEY'
const ENV_NAMES = [ENV_URL, ENV_KEY] as const

export type AccessIo = {
  /** One settings source's `pluginConfigs` and `env`; rejects when it cannot be read. */
  settings: (source: 'user' | 'project' | 'local') => Promise<{ pluginConfigs?: unknown; env?: unknown } | undefined>
  /** The process environment's `ENV_URL` and `ENV_KEY`. */
  env: () => Promise<{ url?: string; apiKey?: string }>
}

export type Off = 'no-key' | 'bad-key' | 'no-url' | 'bad-url' | 'unreadable' | 'repo-option' | 'repo-env'

/** What each refusal tells the user: where to set the option, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  'no-key': `The coolify apiKey option is not set. Set it in the plugin options (/plugin, coolify, configure), or export ${ENV_KEY} (with ${ENV_URL}) before starting Claude.`,
  'bad-key': `The coolify apiKey option (or ${ENV_KEY}, when the options are not set) is not a valid token. Set it again in the plugin options (/plugin, coolify, configure).`,
  'no-url': `The coolify url option is not set. Set it to your instance, such as https://coolify.example.com, in the plugin options (/plugin, coolify, configure), or export ${ENV_URL} (with ${ENV_KEY}) before starting Claude.`,
  'bad-url': `The coolify url option (or ${ENV_URL}, when the options are not set) must be an https address with no user, path, query or fragment, such as https://coolify.example.com. Set it again in the plugin options (/plugin, coolify, configure).`,
  unreadable: `The project or local settings could not be read, so the coolify url and apiKey options (or ${ENV_URL} and ${ENV_KEY}) are not used.`,
  'repo-option':
    'The repository settings declare the coolify url or apiKey option, so neither is used. Set them in your user plugin options instead.',
  'repo-env': `The repository settings set ${ENV_URL} or ${ENV_KEY}, so the coolify url and apiKey are not used. Set them in your user plugin options or your shell's environment instead.`,
}

/** The path every Coolify API call goes under. */
export const API_PATH = '/api/v1'

/** Printable ASCII with no space, so the `Authorization` header cannot be broken by what was pasted. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

export function checkKey(value: unknown): { key: string; off?: undefined } | { key?: undefined; off: 'no-key' | 'bad-key' } {
  if (value === undefined || value === null) return { off: 'no-key' }
  if (typeof value !== 'string') return { off: 'bad-key' }
  const key = value.trim()
  if (!key) return { off: 'no-key' }
  return KEY_SHAPE.test(key) ? { key } : { off: 'bad-key' }
}

/**
 * The API base (`https://host[:port]/api/v1`) of the `url` option, or why there is none. Only https, so the token
 * never travels in clear text; no credentials, query or fragment; the path may be empty or already `/api/v1`.
 */
export function checkUrl(value: unknown): { base: string; off?: undefined } | { base?: undefined; off: 'no-url' | 'bad-url' } {
  if (value === undefined || value === null) return { off: 'no-url' }
  if (typeof value !== 'string') return { off: 'bad-url' }
  const text = value.trim()
  if (!text) return { off: 'no-url' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { off: 'bad-url' }
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#')) {
    return { off: 'bad-url' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  if (path !== '' && path !== API_PATH) return { off: 'bad-url' }
  return { base: url.origin + API_PATH }
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

/** The values a settings source's `env` gives `ENV_NAMES`. */
export function declaredEnv(env: unknown): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>()
  if (!env || typeof env !== 'object') return found
  for (const name of ENV_NAMES) {
    if (Object.hasOwn(env, name)) found.set(name, [(env as Record<string, unknown>)[name]])
  }
  return found
}

/** Whether `repo` declares an option value that `user` does not declare: a value only the repository chose. */
export function repoChose(repo: Map<string, unknown[]>, user: Map<string, unknown[]>): boolean {
  for (const [option, values] of repo) {
    const own = new Set((user.get(option) ?? []).map((v) => JSON.stringify(v)))
    if (values.some((v) => !own.has(JSON.stringify(v)))) return true
  }
  return false
}

export type Access = { key: string; base: string; off?: undefined } | { key?: undefined; base?: undefined; off: Off }

/** Present: a string with something but spaces. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

/** The token and API base to use, or why there are none. Settings are read only when both values are valid. */
export async function resolveAccess(io: AccessIo, options: { url?: unknown; apiKey?: unknown }): Promise<Access> {
  const fromOptions = isSet(options.url) || isSet(options.apiKey)
  const values = fromOptions ? options : await io.env()
  const key = checkKey(values.apiKey)
  if (key.key === undefined) return { off: key.off }
  const url = checkUrl(values.url)
  if (url.base === undefined) return { off: url.off }
  const OPTION_NAMES = ['url', 'apiKey'] as const
  const declared = (settings: { pluginConfigs?: unknown; env?: unknown } | undefined) =>
    fromOptions ? declaredOptions(settings?.pluginConfigs, 'coolify', OPTION_NAMES) : declaredEnv(settings?.env)
  let chosen = false
  try {
    const user = declared(await io.settings('user'))
    for (const source of ['project', 'local'] as const) {
      if (repoChose(declared(await io.settings(source)), user)) chosen = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  return chosen ? { off: fromOptions ? 'repo-option' : 'repo-env' } : { key: key.key, base: url.base }
}
