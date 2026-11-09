import type { EngineInterface, Register } from 'claude-code'
import { ROOT_CHECK, detachedRuns } from './detached'
import { diagnose, report } from './doctor'
import { askRequestOf, commandRequestOf, imageRequestOf, placementError, reviewRequestOf } from './input'
import { locateAgy } from './locate'
import type { Outcome, ProcessRunner, Request } from './model'
import { answerOf, askCommandAnswer, errorText, failure, imageCommandAnswer, notPrivate, startedJob } from './presentation'
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
import { workspaces } from './workspace'

// The defaults of the `foregroundMinutes` and `backgroundMinutes` settings, as plugin.json declares them.
const FOREGROUND_MINUTES = 2
const BACKGROUND_MINUTES = 30

// The settings, refreshed by each register.
let foregroundMs = limitMs(undefined, FOREGROUND_MINUTES)
let backgroundMs = limitMs(undefined, BACKGROUND_MINUTES)
let agyPath: string | undefined
let defaultModel: string | undefined

const runner = createRunner(() => ({ foregroundMs, backgroundMs }))

// Requests running in the foreground, for the status line.
let active = 0

// The session's folder, from session.start (again on a reload): an ask runs there, and jobs are listed and taken
// over within one project.
let project = ''

const optionOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

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
  const outDir = tmp ? `${tmp}/agy` : `/tmp/agy${id ? `-${id}` : ''}`
  const home = await $.env.get('HOME')
  // Where agy keeps each conversation's artifacts folder, the images its image-generator subagent makes among them;
  // without HOME there is none to find, and an image run says it found no image.
  return { outDir, home, artifactsRoot: home ? `${home}/.gemini/antigravity-cli/brain` : '' }
}

async function agyOf($: EngineInterface, home: string | undefined) {
  return locateAgy(agyPath, { exists: path => $.fs.exists(path), path: await $.env.get('PATH'), home })
}

async function depsOf($: EngineInterface): Promise<RunnerDeps> {
  const run = processOf($)
  const { outDir, home, artifactsRoot } = await folders($)
  return {
    files: detachedRuns({ run, read: path => $.fs.read(path).catch(() => undefined), exists: path => $.fs.exists(path) }),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    workspaces: workspaces({ run, list: async path => (await $.fs.list(path)).map(entry => entry.name), dir: `${outDir}/worktrees`, workDir: `${outDir}/.work` }),
    sessionId: () => $.session.id(),
    project: async () => project,
    runsDir: `${outDir}/runs`,
    // Waits go through a host process, which does not use up the hook's clock budget as a timer would.
    sleep: ms => $.process.run(['sleep', String(Math.ceil(ms / 1000))], { timeoutMs: ms + 10_000 }),
    output: {
      write: (path, text) => $.fs.write(path, text),
      outDir,
      artifactsRoot,
      list: path => $.fs.list(path),
      run,
      readBytes: path => $.fs.read(path, { as: 'bytes' }),
    },
    agy: () => agyOf($, home),
    toast: text => $.ui.toast(text),
    submit: text => $.prompt.submit({ text }),
  }
}

/** The model ids `agy models` lists (its first column), or why they could not be read. */
async function modelsOf($: EngineInterface, agy: string): Promise<string[] | { error: string }> {
  try {
    const done = await $.process.run([agy, 'models'], { timeoutMs: 30_000 })
    if (done.exitCode !== 0) return { error: (done.stderr.trim() || done.stdout.trim()).split('\n')[0] || `exit code ${done.exitCode}` }
    return done.stdout.split('\n').flatMap(text => (text.includes('\t') ? [text.split('\t')[0]!.trim()] : []))
  } catch (error) {
    return { error: errorText(error) }
  }
}

/** A request whose model `agy models` lists, or the error that names the valid ids; a request without one passes. */
async function checkedModel($: EngineInterface, request: Request): Promise<Request | string> {
  if (!request.model) return request
  const agy = await agyOf($, (await folders($)).home)
  if (typeof agy !== 'string') return agy.error
  const models = await modelsOf($, agy)
  if (!Array.isArray(models)) return `agy could not list its models (${models.error}), so the run did not start.`
  return models.includes(request.model) ? request : `${request.model} is not an agy model id. agy models lists: ${models.join(', ')}.`
}

/**
 * A request ready to run, or the error to answer: its files and answer where they may be (placementError), the
 * plugin's folder private to the user (ROOT_CHECK, before anything is written there), and its model one agy lists.
 */
async function readyOf($: EngineInterface, request: Request | string): Promise<Request | string> {
  if (typeof request === 'string') return request
  try {
    return await placed($, request)
  } catch (error) {
    return `The agy run did not start: ${errorText(error)}`
  }
}

async function placed($: EngineInterface, request: Request): Promise<Request | string> {
  const { outDir, home } = await folders($)
  const misplaced = placementError(request, { project, outDir, home })
  if (misplaced) return misplaced
  const root = await $.process.run(['sh', '-c', ROOT_CHECK, 'sh', outDir], { timeoutMs: 10_000 })
  if (root.exitCode !== 0) return notPrivate(outDir)
  return checkedModel($, request)
}

async function runNow($: EngineInterface, request: Request): Promise<Outcome> {
  active++
  $.ui.status('agy is working')
  try {
    return await runner.runNow(await depsOf($), request)
  } catch (error) {
    return failure(`The agy run failed: ${errorText(error)}`)
  } finally {
    active--
    $.ui.status(active ? 'agy is working' : undefined)
  }
}

/** A review's request, made runnable in the session's repository, or the error to answer. */
async function reviewOf($: EngineInterface, e: Record<string, unknown>): Promise<Request | string> {
  const request = reviewRequestOf(e, defaultModel)
  if (typeof request === 'string') return request
  return resolveReview(request, async args => {
    const done = await $.process.run(['git', '-C', project, ...args], { timeoutMs: 10_000 })
    return { exitCode: done.exitCode, stdout: done.stdout }
  })
}

async function serve($: EngineInterface, request: Request | string, wait: unknown) {
  const checked = await readyOf($, request)
  if (typeof checked === 'string') return { result: checked, isError: true as const }
  if (wait === false) {
    const job = await runner.startJob(await depsOf($), checked)
    if ('ok' in job) return answerOf(job)
    return { result: startedJob(job) }
  }
  return answerOf(await runNow($, checked))
}

export const register: Register = (on, options) => {
  foregroundMs = limitMs(options?.foregroundMinutes, FOREGROUND_MINUTES)
  backgroundMs = limitMs(options?.backgroundMinutes, BACKGROUND_MINUTES)
  agyPath = optionOf(options?.agyPath)
  defaultModel = optionOf(options?.defaultModel)

  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'antigravity:ask', text: PROMPT, scope: 'session' as const }] }
  })

  // The names stay literal in each call: the engine's scan reads them to classify the command hooks below.
  on('session.start', async ($, e, next) => {
    project = e.cwd
    await $.tool.register({ name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_INPUT_SCHEMA })
    await $.tool.register({ name: 'image', description: IMAGE_DESCRIPTION, inputSchema: IMAGE_INPUT_SCHEMA })
    await $.tool.register({ name: 'review', description: REVIEW_DESCRIPTION, inputSchema: REVIEW_INPUT_SCHEMA })
    await $.tool.register({ name: 'jobs', description: JOBS_DESCRIPTION, inputSchema: JOBS_INPUT_SCHEMA })
    await $.command.register({ name: 'agy-ask', description: ASK_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'agy-image', description: IMAGE_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'agy-review', description: REVIEW_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'agy-doctor', description: DOCTOR_COMMAND_DESCRIPTION })
    // Jobs outlive a reload and the session: watch this session's again and finish what others left, without holding
    // the start up.
    void depsOf($)
      .then(deps => runner.resume(deps))
      .catch(() => undefined)
    return next(e)
  })

  on('tool.call', { tool: 'mcp__antigravity__ask' }, ($, e) => serve($, askRequestOf(e, defaultModel), e.wait))

  on('tool.call', { tool: 'mcp__antigravity__image' }, ($, e) => serve($, imageRequestOf(e, defaultModel), e.wait))

  on('tool.call', { tool: 'mcp__antigravity__review' }, async ($, e) => serve($, await reviewOf($, e), e.wait))

  on('tool.call', { tool: 'mcp__antigravity__jobs' }, async $ => ({ result: await runner.report(await depsOf($)) }))

  on('command.run', { command: 'agy-ask' }, async ($, e) => {
    const request = commandRequestOf(e.args, ASK_USAGE, defaultModel)
    const checked = await readyOf($, request)
    if (typeof checked === 'string') return { text: checked }
    return askCommandAnswer(await runNow($, checked))
  })

  on('command.run', { command: 'agy-image' }, async ($, e) => {
    const checked = await readyOf($, commandRequestOf(e.args, IMAGE_USAGE, defaultModel, 'image'))
    if (typeof checked === 'string') return { text: checked }
    return imageCommandAnswer(await runNow($, checked))
  })

  on('command.run', { command: 'agy-review' }, async ($, e) => {
    const input = reviewCommandInput(e.args)
    if (!input) return { text: REVIEW_USAGE }
    const request = await reviewOf($, input)
    const checked = await readyOf($, request)
    if (typeof checked === 'string') return { text: checked }
    const job = await runner.startJob(await depsOf($), checked)
    return { text: 'ok' in job ? job.text : startedJob(job) }
  })

  on('command.run', { command: 'agy-doctor' }, async $ => {
    const { home, artifactsRoot } = await folders($)
    const artifacts = artifactsRoot ? { path: artifactsRoot, exists: await $.fs.exists(artifactsRoot) } : { path: 'HOME is not set, so agy’s artifacts folder', exists: false }
    const checks = await diagnose({ agy: await agyOf($, home), run: processOf($), models: agy => modelsOf($, agy), artifacts })
    return { text: report(checks) }
  })
}
