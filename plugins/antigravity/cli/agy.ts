// The agy CLI: where it is, its version and models, the environment it gets, and the private agy home every task runs
// in. A private `--gemini-dir` is what keeps the user's own MCP servers, hooks, plugins and skills out of a task (measured
// on agy 1.5.11: `--cli_dir_name` and `--include-default-customizations=false` do not); sign-in still works from it.
import { access, constants, lstat, mkdir, readdir, readFile, rename, stat, writeFile, chmod } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { runProcess } from './process.ts'

/** The subfolder of the agy home that holds this plugin's agy settings (`--cli_dir_name`). */
export const PROFILE = 'spider-antigravity'

/**
 * The agy settings written before every task. A fresh agy home already asks the client before every read, edit and
 * command; these keep it so if agy's default ever changes.
 */
export const PROFILE_SETTINGS = { toolPermission: 'request-review', allowNonWorkspaceAccess: false }

/** agy's own config written into the private home: its multi-agent swarm plugin, on by default, stays off. */
export const HOME_CONFIG = { plugins: { swarm: { enabled: false } } }

export interface Paths {
  /** Everything the plugin keeps: tasks, worktrees and the agy home. */
  state: string
  /** The private agy home (`--gemini-dir`); its conversations make `session/resume` work across tasks. */
  geminiDir: string
  tasks: string
  worktrees: string
}

/** The state folder: `$XDG_STATE_HOME/spider-antigravity`, else `~/.local/state/spider-antigravity`. */
export function pathsOf(env: NodeJS.ProcessEnv): Paths {
  const home = env.HOME ?? ''
  const base = env.XDG_STATE_HOME?.startsWith('/') ? env.XDG_STATE_HOME : join(home, '.local', 'state')
  const state = join(base, 'spider-antigravity')
  return { state, geminiDir: join(state, 'gemini'), tasks: join(state, 'tasks'), worktrees: join(state, 'worktrees') }
}

/** The agy executable: the agyPath option when set, else the first on PATH, else the usual install folders. */
export async function locateAgy(agyPath: string | undefined, env: NodeJS.ProcessEnv): Promise<string | { error: string }> {
  const runnable = (path: string) => access(path, constants.X_OK).then(() => true, () => false)
  if (agyPath) {
    if (!agyPath.startsWith('/')) return { error: `The agyPath option must be an absolute path; it is ${agyPath}.` }
    return (await runnable(agyPath)) ? agyPath : { error: `The agyPath option names ${agyPath}, which is not an executable.` }
  }
  const home = env.HOME ?? ''
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(dir => dir.startsWith('/')), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) if (await runnable(join(dir, 'agy'))) return join(dir, 'agy')
  return { error: 'agy was not found on PATH, in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin: install the Antigravity CLI or set the agyPath option.' }
}

/** Variables agy must not inherit: they would point it at another account, project or home than the task's. */
const AMBIENT = /^(GEMINI|GOOGLE|AGY|CLOUDSDK)_/

/** The environment agy runs with: the caller's, without the ambient Google and agy variables. */
export function agyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !AMBIENT.test(key)))
}

/** `agy --version`, the version alone. */
export async function agyVersion(agy: string, env: NodeJS.ProcessEnv): Promise<string | { error: string }> {
  const run = await runProcess([agy, '--version'], { env: agyEnv(env), timeoutMs: 15_000 })
  const version = run.stdout.trim().split('\n')[0]?.trim() ?? ''
  if (run.code === 0 && /^\d+\.\d+/.test(version)) return version
  return { error: `agy --version failed${run.timedOut ? ' (timed out)' : ''}: ${firstLine(run.stderr || run.stdout || run.spawnError)}` }
}

export interface Model {
  id: string
  name: string
  /** A Claude or GPT model agy also offers: a second opinion from another family should not use one. */
  thirdParty: boolean
}

/** `agy models` lines, `id<TAB>display name`, after its "Fetching available models..." line. */
export function parseModels(stdout: string): Model[] {
  return stdout
    .split('\n')
    .map(line => line.split('\t'))
    .filter((cols): cols is [string, string, ...string[]] => cols.length >= 2 && /^[a-z0-9][a-z0-9.-]*$/.test(cols[0]?.trim() ?? ''))
    .map(([id, name]) => ({ id: id.trim(), name: name.trim(), thirdParty: !id.trim().startsWith('gemini-') }))
}

/** The models the signed-in account offers; an empty list means agy is signed out or failing. */
export async function listModels(agy: string, env: NodeJS.ProcessEnv): Promise<Model[] | { error: string }> {
  const run = await runProcess([agy, 'models'], { env: agyEnv(env), timeoutMs: 30_000 })
  const models = parseModels(run.stdout)
  if (run.code === 0 && models.length > 0) return models
  return { error: `agy models ${run.timedOut ? 'timed out' : 'listed no model'}: ${firstLine(run.stderr || run.stdout || run.spawnError) || 'run agy once to sign in'}` }
}

/**
 * Makes a folder of the plugin's private: created with mode 700, then refused when it is a symlink or another user owns
 * it, and narrowed to 700 when it is wider.
 */
export async function privateDir(path: string): Promise<string | undefined> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory()) return `${path} is not a plain folder; remove it and run again.`
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return `${path} belongs to another user; remove it and run again.`
  if ((info.mode & 0o077) !== 0) await chmod(path, 0o700)
  return undefined
}

/** Writes a file through a temp file and a rename, so a reader never sees half of it. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, path)
}

/** Whether an agy config file configures nothing under `key`: missing, empty, or JSON whose `key` is empty. */
async function configuresNothing(path: string, key: string): Promise<boolean> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : undefined))
  if (info === null) return true
  if (!info) return false
  if (!info.isFile() || info.size > 64_000) return false
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined) return false
  if (!text.trim()) return true
  try {
    const parsed: unknown = JSON.parse(text)
    const value = parsed && typeof parsed === 'object' ? ((parsed as Record<string, unknown>)[key] ?? parsed) : parsed
    return typeof value === 'object' && value !== null && Object.keys(value).length === 0
  } catch {
    return false
  }
}

/** Whether a folder is missing or empty. */
const emptyOrMissing = (path: string) => readdir(path).then(entries => entries.length === 0, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')

/**
 * Prepares the private agy home before a task: private folders, the profile's settings and agy's config, then refuses
 * when something there would run outside the permission checks (MCP servers, hooks, plugins or skills someone added).
 * Resolves an error to report, or undefined when the home is ready.
 */
export async function prepareHome(paths: Paths): Promise<string | undefined> {
  for (const dir of [paths.state, paths.geminiDir, paths.tasks, paths.worktrees]) {
    const refused = await privateDir(dir)
    if (refused) return refused
  }
  const profile = join(paths.geminiDir, 'antigravity-cli', PROFILE)
  const config = join(paths.geminiDir, 'config')
  for (const dir of [join(paths.geminiDir, 'antigravity-cli'), profile, config]) {
    const refused = await privateDir(dir)
    if (refused) return refused
  }
  await writeAtomic(join(profile, 'settings.json'), `${JSON.stringify(PROFILE_SETTINGS, null, 2)}\n`)
  await writeAtomic(join(config, 'config.json'), `${JSON.stringify(HOME_CONFIG, null, 2)}\n`)
  const checks: [boolean, string][] = [
    [await configuresNothing(join(config, 'mcp_config.json'), 'mcpServers'), 'MCP servers in config/mcp_config.json'],
    [await configuresNothing(join(config, 'hooks.json'), 'hooks'), 'hooks in config/hooks.json'],
    [await emptyOrMissing(join(config, 'plugins')), 'plugins in config/plugins'],
    [await emptyOrMissing(join(config, 'skills')), 'skills in config/skills'],
  ]
  const found = checks.filter(([nothing]) => !nothing).map(([, what]) => what)
  if (found.length > 0) return `The plugin's agy home ${paths.geminiDir} has ${found.join(', ')}, which would run outside the permission checks; remove them to delegate to agy.`
  return undefined
}

/** Text from agy that may name a Google Cloud project or region (its errors do), with those parts blanked. */
export const redact = (text: string) =>
  text
    .replace(/\b(projects|locations|regions|zones)\/[^/\s"',}]+/gi, '$1/…')
    // A key naming a project or place, quoted or not, `project_id: x`, `"projectId": "x"`, `location=us-central1`.
    .replace(/(["']?)\b(project(?:[ _-]?(?:id|number|name))?|consumer|location|region|zone)\1(\s*[:=]\s*)(["']?)[^\s"',}]+\4/gi, '$1$2$1$3$4…$4')

/** The first non-empty line of a text from agy, redacted and cut short. */
export function firstLine(text: string | undefined): string {
  return redact((String(text ?? '').trim().split('\n').find(line => line.trim()) ?? '').trim()).slice(0, 300)
}
