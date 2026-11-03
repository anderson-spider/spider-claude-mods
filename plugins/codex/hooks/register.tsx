import type { EngineInterface, Register } from 'claude-code'
import { COMMAND_DESCRIPTION as COMPUTER_USE_COMMAND_DESCRIPTION } from './computer-use/commands'
import { DESCRIPTION as COMPUTER_USE_DESCRIPTION, INPUT_SCHEMA as COMPUTER_USE_INPUT_SCHEMA, PROMPT as COMPUTER_USE_PROMPT } from './computer-use/prompts'
import { known } from './computer-use/known'
import { registerComputerUse } from './computer-use/register'
import { ENABLED, TOOL as COMPUTER_USE_TOOL, UNAME, isMac, isOn } from './computer-use/routing'
import { diagnose, report } from './doctor'
import { commandRequestOf, requestOf } from './input'
import { locateCodex } from './locate'
import type { Kind, OutputDeps, Outcome, ProcessRunner, Request } from './model'
import { answerOf, askCommandAnswer, errorText, imageCommandAnswer } from './presentation'
import { ASK_DESCRIPTION, IMAGE_DESCRIPTION, PROMPT } from './prompts'
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

function processOf($: EngineInterface): ProcessRunner {
  return (argv, init) => $.process.run(argv, init)
}

async function folders($: EngineInterface) {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const home = await $.env.get('HOME')
  const codexHome = ((await $.env.get('CODEX_HOME')) ?? `${home ?? ''}/.codex`).replace(/\/$/, '')
  return { outDir: `${tmp}/codex`, imageCwd: `${tmp}/codex/.work`, codexHome, home }
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
    spawn: (argv, cwd) => $.process.spawn({ argv, cwd }),
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

async function serve($: EngineInterface, kind: Kind, e: Record<string, unknown>) {
  const request = requestOf(kind, e)
  if (typeof request === 'string') return { result: request, isError: true as const }
  if (e.wait === false) {
    const job = await runner.startJob(await depsOf($), request)
    if ('ok' in job) return answerOf(job)
    return { result: `Started job #${job.id}. A message arrives when it ends; the jobs tool lists it meanwhile.` }
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
    await $.tool.register({ name: 'ask', description: ASK_DESCRIPTION, inputSchema: ASK_INPUT_SCHEMA })
    await $.tool.register({ name: 'image', description: IMAGE_DESCRIPTION, inputSchema: IMAGE_INPUT_SCHEMA })
    await $.tool.register({ name: 'jobs', description: JOBS_DESCRIPTION, inputSchema: JOBS_INPUT_SCHEMA })
    await $.command.register({ name: 'codex-ask', description: ASK_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'codex-image', description: IMAGE_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'codex-doctor', description: DOCTOR_COMMAND_DESCRIPTION })
    known.mac = await onMac($)
    if (known.mac) {
      await $.tool.register({ name: 'computer_use', description: COMPUTER_USE_DESCRIPTION, inputSchema: COMPUTER_USE_INPUT_SCHEMA })
      await $.command.register({ name: 'codex-cu', description: COMPUTER_USE_COMMAND_DESCRIPTION })
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__codex__ask' }, ($, e) => serve($, 'ask', e))

  on('tool.call', { tool: 'mcp__codex__image' }, ($, e) => serve($, 'image', e))

  on('tool.call', { tool: 'mcp__codex__jobs' }, async () => ({ result: runner.report() }))

  on('command.run', { command: 'codex-ask' }, async ($, e) => {
    const request = commandRequestOf('ask', e.args, ASK_USAGE)
    if (typeof request === 'string') return { text: request }
    return askCommandAnswer(await runNow($, request))
  })

  on('command.run', { command: 'codex-image' }, async ($, e) => {
    const request = commandRequestOf('image', e.args, IMAGE_USAGE)
    if (typeof request === 'string') return { text: request }
    return imageCommandAnswer(await runNow($, request))
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
