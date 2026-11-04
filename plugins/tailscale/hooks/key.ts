// Where the Tailscale API key comes from. Pure: the settings and environment reads are injected.
// The `apiKey` option comes first, else the SPIDER_PLUGIN_OPTION_TAILSCALE_API_KEY environment variable; the option is
// a source as a whole, so when it is set the variable is ignored. A key that the repository's own settings (project or
// local) declare in the source in use, as the option or in `env`, is not used: the Authorization header would go out
// under an account the repository chose. Settings that cannot be read refuse the call as well. The key is never put in
// a message.

export const ENV_NAME = 'SPIDER_PLUGIN_OPTION_TAILSCALE_API_KEY'

export type KeyIo = {
  /** One settings source's `pluginConfigs` and `env`; rejects when it cannot be read. */
  settings: (source: 'project' | 'local') => Promise<{ pluginConfigs?: unknown; env?: unknown } | undefined>
  /** The process environment's value of `ENV_NAME`. */
  env: () => Promise<string | undefined>
}

export type Off = 'no-key' | 'bad-key' | 'unreadable' | 'repo-key' | 'repo-env'

/** What each refusal tells the user: where to set the option, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  'no-key': `The tailscale apiKey option is not set. Set it in the plugin options (/plugin, tailscale, configure), or export ${ENV_NAME} before starting Claude.`,
  'bad-key': `The tailscale apiKey option (or ${ENV_NAME}, when the option is not set) is not a valid key. Set it again in the plugin options (/plugin, tailscale, configure).`,
  unreadable: `The project or local settings could not be read, so the tailscale apiKey option (or ${ENV_NAME}) is not used.`,
  'repo-key':
    'The repository settings declare the tailscale apiKey option, so it is not used. Set it in your user plugin options instead.',
  'repo-env': `The repository settings set ${ENV_NAME}, so it is not used. Set it in your user plugin options or your shell's environment instead.`,
}

/** Printable ASCII with no space, so the `Authorization` header cannot be broken by what was pasted. */
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

export function checkKey(value: unknown): { key: string; off?: undefined } | { key?: undefined; off: 'no-key' | 'bad-key' } {
  if (value === undefined || value === null) return { off: 'no-key' }
  if (typeof value !== 'string') return { off: 'bad-key' }
  const key = value.trim()
  if (!key) return { off: 'no-key' }
  return KEY_SHAPE.test(key) ? { key } : { off: 'bad-key' }
}

/** Whether a settings source's `pluginConfigs` give this plugin a value for `option`. */
export function declaresOption(configs: unknown, plugin: string, option: string): boolean {
  if (!configs || typeof configs !== 'object') return false
  for (const [name, value] of Object.entries(configs)) {
    if (name !== plugin && !name.startsWith(`${plugin}@`)) continue
    const options = (value as { options?: unknown } | null | undefined)?.options
    if (options && typeof options === 'object' && Object.hasOwn(options, option)) return true
  }
  return false
}

/** Whether a settings source's `env` sets `ENV_NAME`. */
export function declaresEnv(env: unknown): boolean {
  return !!env && typeof env === 'object' && Object.hasOwn(env, ENV_NAME)
}

/** Present: a string with something but spaces. */
const isSet = (value: unknown): boolean => value !== undefined && value !== null && !(typeof value === 'string' && !value.trim())

/** The key to send, or why there is none. Settings are read only for a valid key. */
export async function resolveKey(io: KeyIo, option: unknown): Promise<{ key: string; off?: undefined } | { key?: undefined; off: Off }> {
  const fromOption = isSet(option)
  const checked = checkKey(fromOption ? option : await io.env())
  if (checked.key === undefined) return { off: checked.off }
  let declared = false
  try {
    for (const source of ['project', 'local'] as const) {
      const settings = await io.settings(source)
      if (fromOption ? declaresOption(settings?.pluginConfigs, 'tailscale', 'apiKey') : declaresEnv(settings?.env)) declared = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  return declared ? { off: fromOption ? 'repo-key' : 'repo-env' } : { key: checked.key }
}
