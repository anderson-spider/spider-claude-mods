// antigravity-delegate: the command Claude runs through the Bash tool. Plugin options do not reach a bin/ executable,
// so the skill passes them as flags (`--agy-path`, `--model`), filled in from `${user_config.*}`.
import { parseArgs } from 'node:util'
import { agyVersion, listModels, locateAgy, pathsOf, prepareHome, type Model } from './agy.ts'
import { isMode } from './policy.ts'
import { bucketLine, readUsage, type Bucket } from './quota.ts'
import { RUN_EXIT, runTask } from './run.ts'
import { ROLES, isRole } from './tasks.ts'

/**
 * Exit codes: 0 done, 1 the task or check failed, 2 bad usage, 3 agy is missing or not signed in, 4 the task stopped at
 * actions its mode refuses, 130 the task was stopped.
 */
export const EXIT = RUN_EXIT

const USAGE = `Usage: antigravity-delegate <command> [--agy-path <path>] [--json]

Commands:
  doctor   Check Node, the agy CLI, its version and sign-in, the plugin's private agy home, and the quota.
  models   List the models agy offers, Gemini first (Claude and GPT ones are marked third party).
  quota    Show the quota left, with when each window resets; it spends none.
  run      Delegate a task: --mode read-only --role ask|search|analysis|review --brief-file <file>
           or a change: --mode implement --brief-file <file>, made in a throwaway worktree at HEAD and returned as a patch.
           [--model <id>] [--effort <level>] [--minutes 30] [--idle-minutes 15] [--force]
           A review covers the branch against --base <ref> (default: origin/HEAD, main or master) or one --commit <sha>.
  follow   Go on with a finished task's agy session: --task <id> --brief-file <file> [--mode read-only|implement]
           A follow-up of a change starts from that change's patch; in implement mode its patch includes both.

The task's folder keeps its brief, record and answer; run prints the answer when it ends.
`

export interface Io {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  now: () => number
  cwd?: string
}

const defaultIo: Io = {
  out: text => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`),
  err: text => process.stderr.write(text.endsWith('\n') ? text : `${text}\n`),
  env: process.env,
  now: Date.now,
}

const OPTIONS = {
  'agy-path': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  mode: { type: 'string' },
  role: { type: 'string' },
  'brief-file': { type: 'string' },
  model: { type: 'string' },
  effort: { type: 'string' },
  base: { type: 'string' },
  commit: { type: 'string' },
  minutes: { type: 'string' },
  'idle-minutes': { type: 'string' },
  force: { type: 'boolean' },
  task: { type: 'string' },
} as const

const TASK_OPTIONS = new Set(['mode', 'role', 'brief-file', 'model', 'effort', 'base', 'commit', 'minutes', 'idle-minutes', 'force', 'task'])

const nodeOk = (version: string) => {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 18)
}

export async function cli(argv: string[], io: Io = defaultIo): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS })
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return EXIT.usage
  }
  const [command, ...rest] = parsed.positionals
  if (parsed.values.help || !command) {
    io.out(USAGE)
    return parsed.values.help ? EXIT.ok : EXIT.usage
  }
  if (rest.length > 0) {
    io.err(`${command} takes no arguments.\n\n${USAGE}`)
    return EXIT.usage
  }
  const json = parsed.values.json === true
  const agyPath = given(parsed.values['agy-path'])
  if (command === 'run' || command === 'follow') return task(io, command, parsed.values, agyPath, json)
  const stray = Object.keys(parsed.values).find(name => TASK_OPTIONS.has(name))
  if (stray) {
    io.err(`--${stray} is for run and follow.\n\n${USAGE}`)
    return EXIT.usage
  }
  if (command === 'doctor') return doctor(io, agyPath, json)
  if (command === 'models') return models(io, agyPath, json)
  if (command === 'quota') return quota(io, agyPath, json)
  io.err(`Unknown command ${command}.\n\n${USAGE}`)
  return EXIT.usage
}

const minutesOf = (value: string | undefined, fallback: number) => {
  if (value === undefined) return fallback
  const minutes = Number(value)
  return Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60 ? minutes : undefined
}

// Plugin options arrive as flags the skill fills from `${user_config.*}`: an option left unset is an empty string, or
// the placeholder itself where a Claude Code version does not fill it in.
const given = (value: string | undefined) => (value?.trim() && !value.includes('${user_config.') ? value.trim() : undefined)

async function task(io: Io, command: 'run' | 'follow', values: Record<string, string | boolean | undefined>, agyPath: string | undefined, json: boolean): Promise<number> {
  const text = (name: string) => given(typeof values[name] === 'string' ? (values[name] as string) : undefined)
  const bad = (message: string) => {
    io.err(`${message}\n\n${USAGE}`)
    return EXIT.usage
  }
  const mode = text('mode') ?? 'read-only'
  if (!isMode(mode)) return bad(`--mode is read-only or implement, not ${mode}.`)
  // A change needs no role; a follow-up goes on with a question.
  const role = text('role') ?? (command === 'follow' ? 'ask' : mode === 'implement' ? 'analysis' : undefined)
  if (!isRole(role)) return bad(`run needs --role ${ROLES.join('|')} (or --mode implement).`)
  const briefFile = text('brief-file')
  if (!briefFile) return bad(`${command} needs --brief-file: the whole task, written to a file.`)
  const followed = text('task')
  if (command === 'follow' && !followed) return bad('follow needs --task <id>.')
  if (command === 'run' && followed) return bad('--task is for follow.')
  if (command === 'follow' && (text('base') || text('commit'))) return bad('A follow-up goes on in the same session; --base and --commit are for a new review.')
  const minutes = minutesOf(text('minutes'), 30)
  const idleMinutes = minutesOf(text('idle-minutes'), 15)
  if (minutes === undefined || idleMinutes === undefined) return bad('--minutes and --idle-minutes take a number of minutes, up to a day.')
  const model = text('model')
  const effort = text('effort')
  const base = text('base')
  const commit = text('commit')
  // Claude Code stops a background command with SIGTERM: the task then ends as cancelled, its worktree removed.
  // Every signal is caught while the task runs (a second one too), so it always ends through its cleanup.
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    return await runTask(
      { ...io, cwd: io.cwd ?? process.cwd(), signal: controller.signal },
      {
        mode,
        role,
        briefFile,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(base ? { base } : {}),
        ...(commit ? { commit } : {}),
        minutes,
        idleMinutes,
        force: values.force === true,
        ...(agyPath ? { agyPath } : {}),
        json,
        ...(followed ? { follow: followed } : {}),
      },
    )
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
}

const modelLine = (model: Model) => `${model.id}  ${model.name}${model.thirdParty ? '  (third party)' : ''}`
const sortModels = (list: Model[]) => [...list].sort((a, b) => Number(a.thirdParty) - Number(b.thirdParty))

async function models(io: Io, agyPath: string | undefined, json: boolean): Promise<number> {
  const agy = await locateAgy(agyPath, io.env)
  if (typeof agy !== 'string') return fail(io, agy.error, EXIT.unavailable)
  const list = await listModels(agy, io.env)
  if (!Array.isArray(list)) return fail(io, list.error, EXIT.unavailable)
  io.out(json ? JSON.stringify(sortModels(list), null, 2) : sortModels(list).map(modelLine).join('\n'))
  return EXIT.ok
}

async function quota(io: Io, agyPath: string | undefined, json: boolean): Promise<number> {
  const agy = await locateAgy(agyPath, io.env)
  if (typeof agy !== 'string') return fail(io, agy.error, EXIT.unavailable)
  const paths = pathsOf(io.env)
  const refused = await prepareHome(paths)
  if (refused) return fail(io, refused, EXIT.failed)
  const buckets = await readUsage(agy, paths.tasks, io.env)
  if (!Array.isArray(buckets)) return fail(io, buckets.error, EXIT.failed)
  io.out(json ? JSON.stringify(buckets, null, 2) : buckets.map(bucket => bucketLine(bucket, io.now())).join('\n'))
  return EXIT.ok
}

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function doctor(io: Io, agyPath: string | undefined, json: boolean): Promise<number> {
  const checks: Check[] = []
  const add = (name: string, ok: boolean, detail: string) => void checks.push({ name, ok, detail })
  add('node', nodeOk(process.version), `${process.version}${nodeOk(process.version) ? '' : ' (needs 22.18 or later)'}`)
  const agy = await locateAgy(agyPath, io.env)
  if (typeof agy !== 'string') add('agy', false, agy.error)
  else {
    add('agy', true, agy)
    const version = await agyVersion(agy, io.env)
    add('version', typeof version === 'string', typeof version === 'string' ? version : version.error)
    const list = await listModels(agy, io.env)
    add('sign-in', Array.isArray(list), Array.isArray(list) ? `${list.filter(model => !model.thirdParty).length} Gemini models: ${list.filter(model => !model.thirdParty).map(model => model.id).join(', ')}` : list.error)
  }
  const paths = pathsOf(io.env)
  const refused = await prepareHome(paths).catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  add('agy home', !refused, refused ?? `${paths.geminiDir} (private; no MCP servers, hooks, plugins or skills)`)
  let buckets: Bucket[] | { error: string } = { error: 'skipped: no agy' }
  if (typeof agy === 'string' && !refused) buckets = await readUsage(agy, paths.tasks, io.env)
  add('quota', Array.isArray(buckets), Array.isArray(buckets) ? buckets.map(bucket => bucketLine(bucket, io.now())).join('; ') : buckets.error)
  const ok = checks.every(check => check.ok)
  io.out(json ? JSON.stringify({ ok, checks }, null, 2) : checks.map(check => `${check.ok ? 'ok ' : 'FAIL'} ${check.name}: ${check.detail}`).join('\n'))
  return ok ? EXIT.ok : typeof agy !== 'string' || !checks.find(check => check.name === 'sign-in')?.ok ? EXIT.unavailable : EXIT.failed
}

function fail(io: Io, message: string, code: number): number {
  io.err(message)
  return code
}
