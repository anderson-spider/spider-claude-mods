// Where the ComfyUI instance comes from. Pure: the settings and environment reads are injected.
// The `url` option comes first, else the SPIDER_PLUGIN_OPTION_COMFYUI_LOCAL_URL environment variable. A url declared by
// the repository's own settings (project or local), as the option or in `env`, with a value the user's settings do not
// give it refuses the call: the model uploads local files and saves what the server answers,
// so a repository must not pick the server. The same value as the user's is not a choice of the repository: with Claude
// opened in the home folder, the project settings are the user's own ~/.claude/settings.json. Settings that cannot be
// read refuse the call as well. No message carries a value.

export const ENV_NAME = 'SPIDER_PLUGIN_OPTION_COMFYUI_LOCAL_URL'

export type AccessIo = {
  /** One settings source's `pluginConfigs` and `env`; rejects when it cannot be read. */
  settings: (source: 'user' | 'project' | 'local') => Promise<{ pluginConfigs?: unknown; env?: unknown } | undefined>
  /** The process environment's value of `ENV_NAME`. */
  env: () => Promise<string | undefined>
}

export type Off = 'no-url' | 'bad-url' | 'unreadable' | 'repo-option' | 'repo-env'

/** What each refusal tells the user: where to set the option, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  'no-url': `The comfyui-local url option is not set. Set it to your server, such as http://comfy.local:8188, in the plugin options (/plugin, comfyui-local, configure), or export ${ENV_NAME} before starting Claude.`,
  'bad-url':
    `The comfyui-local url option (or ${ENV_NAME}, when the option is not set) must be an http or https origin with no user, path, query or fragment, such as http://comfy.local:8188. Set it again in the plugin options (/plugin, comfyui-local, configure).`,
  unreadable: `The project or local settings could not be read, so the comfyui-local url option (or ${ENV_NAME}) is not used.`,
  'repo-option': 'The repository settings declare the comfyui-local url option, so it is not used. Set it in your user plugin options instead.',
  'repo-env': `The repository settings set ${ENV_NAME}, so the comfyui-local url is not used. Set it in your user plugin options or your shell's environment instead.`,
}

/** The server origin (`http://host[:port]`) of the `url` option, or why there is none. http is allowed: the server is on the local network. */
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
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#')) {
    return { off: 'bad-url' }
  }
  if (url.pathname.replace(/\/+$/, '') !== '') return { off: 'bad-url' }
  return { base: url.origin }
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

/** Whether `repo` declares an option value that `user` does not declare: a value only the repository chose. */
export function repoChose(repo: Map<string, unknown[]>, user: Map<string, unknown[]>): boolean {
  for (const [option, values] of repo) {
    const own = new Set((user.get(option) ?? []).map((v) => JSON.stringify(v)))
    if (values.some((v) => !own.has(JSON.stringify(v)))) return true
  }
  return false
}

/** The values a settings source's `env` gives `ENV_NAME`. */
export function declaredEnv(env: unknown): Map<string, unknown[]> {
  const found = new Map<string, unknown[]>()
  if (env && typeof env === 'object' && Object.hasOwn(env, ENV_NAME)) found.set(ENV_NAME, [(env as Record<string, unknown>)[ENV_NAME]])
  return found
}

/** Present: a string with something but spaces. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

export type Access = { base: string; off?: undefined } | { base?: undefined; off: Off }

const PLUGIN = 'comfyui-local'
const OPTIONS = ['url'] as const

/** The server origin to use, or why there is none. Settings are read only when the url is valid. */
export async function resolveAccess(io: AccessIo, options: { url?: unknown }): Promise<Access> {
  const fromOption = isSet(options.url)
  const url = checkUrl(fromOption ? options.url : await io.env())
  if (url.base === undefined) return { off: url.off }
  const declared = (settings: { pluginConfigs?: unknown; env?: unknown } | undefined) =>
    fromOption ? declaredOptions(settings?.pluginConfigs, PLUGIN, OPTIONS) : declaredEnv(settings?.env)
  let chosen = false
  try {
    const user = declared(await io.settings('user'))
    for (const source of ['project', 'local'] as const) {
      if (repoChose(declared(await io.settings(source)), user)) chosen = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  return chosen ? { off: fromOption ? 'repo-option' : 'repo-env' } : { base: url.base }
}
