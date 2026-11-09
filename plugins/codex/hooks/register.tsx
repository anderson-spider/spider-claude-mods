import type { EngineInterface, Register } from 'claude-code'
import { COMMAND_DESCRIPTION as COMPUTER_USE_COMMAND_DESCRIPTION } from './computer-use/commands'
import { DESCRIPTION as COMPUTER_USE_DESCRIPTION, INPUT_SCHEMA as COMPUTER_USE_INPUT_SCHEMA, PROMPT as COMPUTER_USE_PROMPT } from './computer-use/prompts'
import { known } from './computer-use/known'
import { registerComputerUse } from './computer-use/register'
import { ENABLED, TOOL as COMPUTER_USE_TOOL, UNAME, isMac, isOn } from './computer-use/routing'
import { ROOT_CHECK, detachedRuns } from './detached'
import { diagnose, report } from './doctor'
import { commandRequestOf, placementError, requestOf, reviewRequestOf } from './input'
import { locateCodex } from './locate'
import type { Kind, OutputDeps, Outcome, ProcessRunner, Request } from './model'
import { answerOf, askCommandAnswer, errorText, imageCommandAnswer, notPrivate, reviewCommandAnswer } from './presentation'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION, PROMPT, REVIEW_DESCRIPTION } from './prompts'
import { resolveReview, reviewCommandInput } from './review'
import { createRunner, type RunnerDeps } from './runner'
import { limitMs } from './settings'
import {
  ASK_COMMAND_DESCRIPTION,
  ASK_INPUT_SCHEMA,
  ASK_USAGE,
  DOCTOR_COMMAND_DESCRIPTION,
  IMAGE_COMMAND_DESCRIPTION,
  IMAGE_INPUT_SCHEMA,
  IMAGE_USAGE,
  JOBS_DESCRIPTION,
  JOBS_INPUT_SCHEMA,
  REVIEW_COMMAND_DESCRIPTION,
  REVIEW_INPUT_SCHEMA,
  REVIEW_USAGE,
} from './tool-schemas'

// The defaults of the `foregroundMinutes` and `backgroundMinutes` settings, as plugin.json declares them.
const FOREGROUND_MINUTES = 6
const BACKGROUND_MINUTES = 30

// The settings, refreshed by each register.
let foregroundMs = limitMs(undefined, FOREGROUND_MINUTES)
let backgroundMs = limitMs(undefined, BACKGROUND_MINUTES)
let codexPath: string | undefined

const runner = createRunner(() => ({ foregroundMs, backgroundMs }))

// Requests running in the foreground, for the status line.
let active = 0

// The session's folder, from session.start (again on a reload): jobs are listed and taken over within one project.
let project = ''

function processOf($: EngineInterface): ProcessRunner {
  return (argv, init) => $.process.run(argv, init)
}

// The user's id, kept once read: without TMPDIR the plugin's folder is named by it, away from other users' in /tmp.
// A failed read is tried again next time; meanwhile the folder is the bare name, which ROOT_CHECK still guards.
let uid: string | undefined

async function uidOf($: EngineInterface): Promise<string | undefined> {
  if (uid) return uid
  const done = await $.process.run(['id', '-u'], { timeoutMs: 5_000 }).catch(() => undefined)
  const id = done?.exitCode === 0 ? done.stdout.trim() : ''
  if (/^\d+$/.test(id)) uid = id
  return uid
}

async function folders($: EngineInterface) {
  const tmp = (await $.env.get('TMPDIR'))?.replace(/\/$/, '')
  const id = tmp ? undefined : await uidOf($)
  const outDir = tmp ? `${tmp}/codex` : `/tmp/codex${id ? `-${id}` : ''}`
  const home = await $.env.get('HOME')
  const codexHome = ((await $.env.get('CODEX_HOME')) ?? `${home ?? ''}/.codex`).replace(/\/$/, '')
  return { outDir, imageCwd: `${outDir}/.work`, codexHome, home }
}

/**
 * A request ready to run, or the error to answer: its `out` where it may be (placementError), and the plugin's folder
 * private to the user (ROOT_CHECK), before anything is written there.
 */
async function readyOf($: EngineInterface, request: Request | string): Promise<Request | string> {
  if (typeof request === 'string') return request
  try {
    return await placed($, request)
  } catch (error) {
    return `The Codex run did not start: ${errorText(error)}`
  }
}

async function placed($: EngineInterface, request: Request): Promise<Request | string> {
  const { outDir } = await folders($)
  const misplaced = placementError(request, { project, outDir })
  if (misplaced) return misplaced
  const root = await $.process.run(['sh', '-c', ROOT_CHECK, 'sh', outDir], { timeoutMs: 10_000 })
  return root.exitCode === 0 ? request : notPrivate(outDir)
}

async function codexOf($: EngineInterface, home: string | undefined) {
  return locateCodex(codexPath, { exists: path => $.fs.exists(path), path: await $.env.get('PATH'), home })
}

async function depsOf($: EngineInterface): Promise<RunnerDeps> {
  const run = processOf($)
  const { outDir, imageCwd, codexHome, home } = await folders($)
  const output: OutputDeps = {
    run,
    write: (path, text) => $.fs.write(path, text),
    readBytes: path => $.fs.read(path, { as: 'bytes' }),
    list: path => $.fs.list(path),
    outDir,
    codexHome,
  }
  return {
    files: detachedRuns({
      run,
      read: path => $.fs.read(path).catch(() => undefined),
      exists: path => $.fs.exists(path),
      codexHome,
    }),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    sessionId: () => $.session.id(),
    project: async () => project,
    runsDir: `${outDir}/runs`,
    // Waits go through a host process, which does not use up the hook's clock budget as a timer would.
    sleep: ms => $.process.run(['sleep', String(Math.ceil(ms / 1000))], { timeoutMs: ms + 10_000 }),
    output,
    codex: () => codexOf($, home),
    imageCwd,
    toast: text => $.ui.toast(text),
    submit: text => $.prompt.submit({ text }),
  }
}

/** Whether this machine runs macOS; a `uname` that cannot run answers no. */
async function onMac($: EngineInterface) {
  try {
    return isMac((await $.process.run(UNAME, { timeoutMs: 3000 })).stdout)
  } catch {
    return false
  }
}

async function runNow($: EngineInterface, request: Request): Promise<Outcome> {
  active++
  $.ui.status('Codex is working')
  try {
    return await runner.runNow(await depsOf($), request)
  } catch (error) {
    const text = `The Codex run failed: ${errorText(error)}`
    return { ok: false, text, error: text }
  } finally {
    active--
    $.ui.status(active ? 'Codex is working' : undefined)
  }
}

/** A review's request, made runnable in the session's repository, or the error to answer. */
async function reviewOf($: EngineInterface, e: Record<string, unknown>): Promise<Request | string> {
  const request = reviewRequestOf(e)
  if (typeof request === 'string') return request
  return resolveReview(request, async args => {
    const done = await $.process.run(['git', ...args], { timeoutMs: 10_000 })
    return { exitCode: done.exitCode, stdout: done.stdout }
  })
}

async function serve($: EngineInterface, kind: Kind, e: Record<string, unknown>) {
  const request = await readyOf($, kind === 'review' ? await reviewOf($, e) : requestOf(kind, e))
  if (typeof request === 'string') return { result: request, isError: true as const }
  if (e.wait === false) {
    const job = await runner.startJob(await depsOf($), request)
    if ('ok' in job) return answerOf(job)
    return { result: `Started job #${job.id}. A message arrives when it ends, even after a plugin reload; the jobs tool lists it meanwhile.` }
  }
  return answerOf(await runNow($, request))
}

export const register: Register = (on, options) => {
  foregroundMs = limitMs(options?.foregroundMinutes, FOREGROUND_MINUTES)
  backgroundMs = limitMs(options?.backgroundMinutes, BACKGROUND_MINUTES)
  codexPath = typeof options?.codexPath === 'string' && options.codexPath.trim() ? options.codexPath.trim() : undefined

  // Computer use owns its other hooks in its own folder; session.start and prompt.compose below add its tool, command
  // and prompt section, since a plugin holds each of those events once.
  registerComputerUse(on, options)

  // The computer use section is added only while /codex-cu is on, so the next request already sees the switch.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections, { id: 'codex:ask', text: PROMPT, scope: 'session' as const }]
    // A failed read of the switch leaves computer use out and keeps the ask section.
    const stored = await $.store.get(ENABLED).then(isOn, () => undefined)
    if (stored !== undefined) known.enabled = stored
    if (stored) {
      sections.push({ id: 'codex:computer-use', text: COMPUTER_USE_PROMPT(COMPUTER_USE_TOOL), scope: 'session' as const })
    }
    return { sections }
  })

  // The names stay literal in each call: the engine's scan reads them to classify the command hooks below.
  on('session.start', async ($, e, next) => {
    project = e.cwd
    await $.tool.register({ name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_INPUT_SCHEMA })
    await $.tool.register({ name: 'image', description: IMAGE_DESCRIPTION, inputSchema: IMAGE_INPUT_SCHEMA })
    await $.tool.register({ name: 'review', description: REVIEW_DESCRIPTION, inputSchema: REVIEW_INPUT_SCHEMA })
    await $.tool.register({ name: 'jobs', description: JOBS_DESCRIPTION, inputSchema: JOBS_INPUT_SCHEMA })
    await $.command.register({ name: 'codex-ask', description: ASK_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'codex-image', description: IMAGE_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'codex-review', description: REVIEW_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'codex-doctor', description: DOCTOR_COMMAND_DESCRIPTION })
    known.mac = await onMac($)
    if (known.mac) {
      await $.tool.register({ name: 'computer_use', description: COMPUTER_USE_DESCRIPTION, inputSchema: COMPUTER_USE_INPUT_SCHEMA })
      await $.command.register({ name: 'codex-cu', description: COMPUTER_USE_COMMAND_DESCRIPTION })
    }
    // Jobs outlive a reload and the session: watch this session's again and finish what others left, without holding
    // the start up.
    void depsOf($)
      .then(deps => runner.resume(deps))
      .catch(() => undefined)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex__ask' }, ($, e) => serve($, 'ask', e))

  on('tool.call', { tool: 'mcp__codex__image' }, ($, e) => serve($, 'image', e))

  on('tool.call', { tool: 'mcp__codex__review' }, ($, e) => serve($, 'review', e))

  on('tool.call', { tool: 'mcp__codex__jobs' }, async $ => ({ result: await runner.report(await depsOf($)) }))

  on('command.run', { command: 'codex-ask' }, async ($, e) => {
    const request = await readyOf($, commandRequestOf('ask', e.args, ASK_USAGE))
    if (typeof request === 'string') return { text: request }
    return askCommandAnswer(await runNow($, request))
  })

  on('command.run', { command: 'codex-image' }, async ($, e) => {
    const request = await readyOf($, commandRequestOf('image', e.args, IMAGE_USAGE))
    if (typeof request === 'string') return { text: request }
    return imageCommandAnswer(await runNow($, request))
  })

  on('command.run', { command: 'codex-review' }, async ($, e) => {
    const input = reviewCommandInput(e.args)
    if (!input) return { text: REVIEW_USAGE }
    const request = await readyOf($, await reviewOf($, input))
    if (typeof request === 'string') return { text: request }
    return reviewCommandAnswer(await runNow($, request))
  })

  on('command.run', { command: 'codex-doctor' }, async $ => {
    const { codexHome, home } = await folders($)
    const configPath = `${codexHome}/config.toml`
    const checks = await diagnose({
      codex: await codexOf($, home),
      run: processOf($),
      config: async () => ((await $.fs.exists(configPath)) ? $.fs.read(configPath) : undefined),
      configPath,
    })
    return { text: report(checks) }
  })
}
