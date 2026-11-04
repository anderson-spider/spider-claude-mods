// Which token goes to which GitLab. Pure: the settings read is injected.
// The `tokens` option comes first, else the SPIDER_PLUGIN_OPTION_GITLAB_TOKENS environment variable: `host=token`
// pairs either way, so one plugin serves gitlab.com and any self-managed instance. The option is a source as a whole:
// when it is set the variable is ignored, and pairs of the two are never mixed. A token goes only to the host it is
// paired with, the one the repository's remote names. Tokens that the repository's own settings (project or local)
// declare in the source in use, as the option or in `env`, are not used, and settings that cannot be read refuse the
// call. A token is never put in a message. The variable's name avoids GITLAB_TOKEN and the other names GitLab tools read.

export type TokenIo = {
  /** One settings source's `pluginConfigs`; rejects when it cannot be read. */
  settings: (source: 'project' | 'local') => Promise<{ pluginConfigs?: unknown; env?: unknown } | undefined>
  /** The process environment's value of `ENV_NAME`. */
  env: () => Promise<string | undefined>
}

export const ENV_NAME = 'SPIDER_PLUGIN_OPTION_GITLAB_TOKENS'

export type Off = 'no-tokens' | 'bad-tokens' | 'no-host' | 'unreadable' | 'repo-tokens' | 'repo-env'

const CONFIGURE = 'the plugin options (/plugin, gitlab, configure)'

/** What each refusal tells the user: where to set the option, never a value. `no-host` names the host, which is not secret. */
export function offText(off: Off, host?: string): string {
  switch (off) {
    case 'no-tokens':
      return `The gitlab tokens option is not set. Set it in ${CONFIGURE} as host=token pairs, or export ${ENV_NAME} with the same pairs before starting Claude.`
    case 'bad-tokens':
      return `The gitlab tokens option (or ${ENV_NAME}, when the option is not set) is not a list of host=token pairs. Set it again in ${CONFIGURE}.`
    case 'no-host':
      return `The gitlab tokens option has no token for ${host ?? 'this host'}. Add ${host ?? '<host>'}=<token> in ${CONFIGURE}, or in ${ENV_NAME} when the option is not set.`
    case 'unreadable':
      return `The project or local settings could not be read, so the gitlab tokens option (or ${ENV_NAME}) is not used.`
    case 'repo-tokens':
      return 'The repository settings declare the gitlab tokens option, so it is not used. Set it in your user plugin options instead.'
    case 'repo-env':
      return `The repository settings set ${ENV_NAME}, so it is not used. Set it in your user plugin options or your shell's environment instead.`
  }
}

/** Printable ASCII with no space, comma or `=`, so the header cannot be broken by what was pasted. */
const TOKEN = /^[\x21-\x2b\x2d-\x3c\x3e-\x7e]{1,512}$/
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/

/** The host-to-token map of the option: pairs separated by commas or whitespace. Any malformed pair refuses the whole option. */
export function parseTokens(value: unknown): { tokens: Map<string, string>; off?: undefined } | { tokens?: undefined; off: 'no-tokens' | 'bad-tokens' } {
  if (value === undefined || value === null) return { off: 'no-tokens' }
  if (typeof value !== 'string') return { off: 'bad-tokens' }
  const pairs = value.split(/[\s,]+/).filter(Boolean)
  if (pairs.length === 0) return { off: 'no-tokens' }
  const tokens = new Map<string, string>()
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    const host = pair.slice(0, at).toLowerCase()
    const token = pair.slice(at + 1)
    if (at <= 0 || !HOST.test(host) || !TOKEN.test(token) || tokens.has(host)) return { off: 'bad-tokens' }
    tokens.set(host, token)
  }
  return { tokens }
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

/** The token for `host`, or why there is none. Settings are read only once a token was found. */
export async function resolveToken(
  io: TokenIo,
  option: unknown,
  host: string,
): Promise<{ token: string; off?: undefined } | { token?: undefined; off: Off }> {
  const fromOption = isSet(option)
  const parsed = parseTokens(fromOption ? option : await io.env())
  if (parsed.tokens === undefined) return { off: parsed.off }
  const token = parsed.tokens.get(host)
  if (token === undefined) return { off: 'no-host' }
  let declared = false
  try {
    for (const source of ['project', 'local'] as const) {
      const settings = await io.settings(source)
      if (fromOption ? declaresOption(settings?.pluginConfigs, 'gitlab', 'tokens') : declaresEnv(settings?.env)) declared = true
    }
  } catch {
    return { off: 'unreadable' }
  }
  return declared ? { off: fromOption ? 'repo-tokens' : 'repo-env' } : { token }
}
