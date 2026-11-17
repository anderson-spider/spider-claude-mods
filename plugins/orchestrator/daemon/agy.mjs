// The Antigravity provider: where agy is, its isolated profile, and the argv of its ACP agent.
import { access, constants, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** The provider instance id the tools name, and its driver kind. */
export const AGY = 'agy'
export const AGY_DRIVER = 'antigravity'

/**
 * agy's settings folder for the orchestrator's runs (`--cli_dir_name`), beside the user's own, so the user's
 * `toolPermission` (often `always-proceed`) never applies; the sign-in is shared.
 */
export const PROFILE = 'spider-orchestrator'

/**
 * The profile's settings, written before every run: every edit and command reaches the client as a permission request,
 * which the runtime mode answers (policy.mjs). Under `always-proceed` none would, and nothing would show it.
 */
export const PROFILE_SETTINGS = { toolPermission: 'request-review', allowNonWorkspaceAccess: false }

/** @param {string} home */
export const profileDirOf = (home) => join(home, '.gemini', 'antigravity-cli', PROFILE)

/** The ACP agent's argv: its own sandbox for commands on top of the client's answers. */
/** @param {string} agy */
export const acpArgv = (agy) => [agy, 'acp', `--cli_dir_name=${PROFILE}`, '--sandbox']

/**
 * The agy executable: the agyPath option when set, else the first on PATH, else the usual install folders.
 * @param {string | undefined} agyPath
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<string | { error: string }>}
 */
export async function locateAgy(agyPath, env) {
  const runnable = (/** @type {string} */ path) => access(path, constants.X_OK).then(() => true, () => false)
  if (agyPath) return (await runnable(agyPath)) ? agyPath : { error: `The agyPath option names ${agyPath}, which is not an executable.` }
  const home = env.HOME ?? ''
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) if (await runnable(join(dir, 'agy'))) return join(dir, 'agy')
  return { error: 'agy was not found on PATH, in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin: install the Antigravity CLI or set the agyPath option.' }
}

/**
 * Whether a profile config file sets nothing: missing, empty, or JSON with no hooks or servers. Hooks and MCP servers
 * run before a client can refuse a tool, so a profile with any is not used (as T3 Code's text generation checks).
 * @param {string} path
 * @param {'hooks' | 'mcpServers'} key
 */
async function setsNothing(path, key) {
  const info = await stat(path).catch(() => undefined)
  if (!info) return true
  if (!info.isFile() || info.size > 64_000) return false
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return false
  if (!text.trim()) return true
  try {
    const parsed = JSON.parse(text)
    const value = parsed?.[key] ?? parsed
    return typeof value === 'object' && value !== null && Object.keys(value).length === 0
  } catch {
    return false
  }
}

/**
 * Writes the profile's settings (a temp file, then a rename) and checks its config; resolves an error to answer, or
 * undefined when the profile is ready.
 * @param {string} home
 */
export async function prepareProfile(home) {
  const dir = profileDirOf(home)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'settings.json')
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(PROFILE_SETTINGS, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
  for (const [name, key] of /** @type {const} */ ([['hooks.json', 'hooks'], ['mcp_config.json', 'mcpServers']])) {
    if (!(await setsNothing(join(dir, 'config', name), key))) {
      return `agy's orchestrator profile sets ${key === 'hooks' ? 'hooks' : 'MCP servers'} in ${join(dir, 'config', name)}, which would run outside the permission checks; empty it to delegate to agy.`
    }
  }
  return undefined
}
