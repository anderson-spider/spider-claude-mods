// Repository settings cannot choose the account receiving the user's task.
// The key is the `apiKey` plugin option when it is set, else SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY, else
// JEV_API_KEY from the user's environment (the first of the two that is set is the environment source). A key that the
// repository's own settings (project or local) declare for the source in use (the option, or either variable in `env`)
// is refused, and so are settings that cannot be read.
export type KeyIo = {
  /** Missing settings are undefined; unreadable settings reject. */
  settings: (source: 'project' | 'local') => Promise<{ env?: unknown; pluginConfigs?: unknown } | undefined>
}

/** Where the key came from: the plugin option, or the environment when the option is not set. */
export type KeySource = 'option' | 'env'
/** The raw values of both sources, before any check. */
export type KeySources = { option?: unknown; env?: unknown }

export const PLUGIN = 'subagent-effort'
export const OPTION = 'apiKey'
/** The environment variables, in the order they are tried. */
export const ENV_NAMES = ['SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY', 'JEV_API_KEY'] as const

/** The first of the variables' values that is set and not blank, with its name (JEV_API_KEY when none is). Values are read by the caller, since the host takes only literal names. */
export function pickEnv(values: readonly [string | undefined, string | undefined]): { name: string; value: string | undefined } {
  for (const [index, name] of ENV_NAMES.entries()) {
    const value = values[index]
    if (value !== undefined && value.trim()) return { name, value }
  }
  return { name: ENV_NAMES[1], value: undefined }
}

/** Why the key is not used: a configuration problem, unlike a Jev failure, so it lasts until the person fixes it. */
export const OFFS = ['no-key', 'bad-key', 'unreadable-settings', 'repo-declared-key'] as const
export type Off = (typeof OFFS)[number]
export const isOff = (reason: unknown): reason is Off => (OFFS as readonly unknown[]).includes(reason)
/** What each reason tells the person: what is wrong and where to fix it, never a value. */
export const OFF_TEXT: Record<Off, string> = {
  'no-key': 'No Jev key. Set the subagent-effort apiKey option (/plugin, subagent-effort, configure), or set SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY (or JEV_API_KEY) where Claude Code inherits it (your shell profile for the terminal, `launchctl setenv` for the macOS desktop app) and restart Claude Code.',
  'bad-key': 'The Jev key (the apiKey option, or SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY or JEV_API_KEY when the option is not set) is not a valid key (printable characters, no spaces). Set it again.',
  'unreadable-settings': 'The project or local settings could not be read, so the Jev key (apiKey option, SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY or JEV_API_KEY) is not used. Fix .claude/settings.json or .claude/settings.local.json so each is valid JSON.',
  'repo-declared-key': 'The project or local settings declare the Jev key in use (the subagent-effort apiKey option, or SPIDER_PLUGIN_OPTION_SUBAGENT_EFFORT_API_KEY or JEV_API_KEY in env), so it is not used. Remove it from the repository settings and keep it in your user plugin options or your own environment.',
}
export type Access = { key: string; source: KeySource; off?: undefined } | { key?: undefined; source?: undefined; off: Off }
const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/

/** Printable ASCII without spaces, so the Authorization header cannot be broken by a pasted key. */
export function checkKey(value: unknown): { key: string; off?: undefined } | { key?: undefined; off: 'no-key' | 'bad-key' } {
  if (value === undefined || value === null) return { off: 'no-key' }
  if (typeof value !== 'string') return { off: 'bad-key' }
  const key = value.trim()
  if (!key) return { off: 'no-key' }
  return KEY_SHAPE.test(key) ? { key } : { off: 'bad-key' }
}

/** An option that is absent, null or blank is not set, so the environment is used; any other value is the option's, valid or not. */
export function pickSource(sources: KeySources): { source: KeySource; value: unknown } {
  const { option } = sources
  const unset = option === undefined || option === null || (typeof option === 'string' && !option.trim())
  return unset ? { source: 'env', value: sources.env } : { source: 'option', value: option }
}

/** Whether a settings source's `pluginConfigs` give this plugin a value for the option. */
export function declaresOption(configs: unknown): boolean {
  if (!configs || typeof configs !== 'object') return false
  for (const [name, value] of Object.entries(configs)) {
    if (name !== PLUGIN && !name.startsWith(`${PLUGIN}@`)) continue
    const options = (value as { options?: unknown } | null | undefined)?.options
    if (options && typeof options === 'object' && Object.hasOwn(options, OPTION)) return true
  }
  return false
}

/** Any own declaration of the source in use counts, including empty, null and a value equal to the user's key. */
export async function repoDeclares(io: KeyIo, source: KeySource): Promise<boolean> {
  let declared = false
  for (const where of ['project', 'local'] as const) {
    const settings = await io.settings(where)
    if (source === 'option') {
      if (declaresOption(settings?.pluginConfigs)) declared = true
    } else {
      const env = settings?.env
      if (env && typeof env === 'object' && ENV_NAMES.some((name) => Object.hasOwn(env, name))) declared = true
    }
  }
  return declared
}

/** The key to send and its source, or why there is none. Settings are read only for a valid key. */
export async function resolveAccess(io: KeyIo, sources: KeySources): Promise<Access> {
  const { source, value } = pickSource(sources)
  const checked = checkKey(value)
  if (checked.key === undefined) return { off: checked.off }
  try {
    if (await repoDeclares(io, source)) return { off: 'repo-declared-key' }
  } catch {
    return { off: 'unreadable-settings' }
  }
  return { key: checked.key, source }
}
