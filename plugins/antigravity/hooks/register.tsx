import type { EngineInterface, Register } from 'claude-code'
import type { JobStore } from './model'
import { PROMPT } from './prompts'
import { createService, type Host } from './service'
import { settingsOf } from './settings'
import {
  ASK_COMMAND_DESCRIPTION,
  DOCTOR_COMMAND_DESCRIPTION,
  IMAGE_COMMAND_DESCRIPTION,
  REVIEW_COMMAND_DESCRIPTION,
} from './tool-schemas'

// The hooks module: the four commands, the system prompt section, and the watch on background jobs. The tools come
// from the MCP server (server/main.mjs), so the module registers no event that turns Code Mode off (tool.call,
// session.send and the like).

// How often the module looks for the jobs its MCP server handed off, and for its foreground runs.
const PICK_UP_MS = 2_000

// The settings, refreshed by each register.
let settings = settingsOf(undefined)
const service = createService(() => settings)

// The session's folder, from session.start (again on a reload): an ask runs there, and jobs are listed and taken
// over within one project.
let project = ''

// The Claude Code process: the parent of a command this module runs, as it is of the MCP server, so the jobs the
// server hands off are found as this session's.
let pid: number | undefined

async function claudePid($: EngineInterface): Promise<number | undefined> {
  const run = await $.process.run(['sh', '-c', 'echo $PPID'], { timeoutMs: 5_000 }).catch(() => undefined)
  const found = Number(run?.stdout.trim())
  return Number.isInteger(found) && found > 1 ? found : undefined
}

/** The host the plugin's pure modules run on, from `$`. */
export function hostOf($: EngineInterface): Host {
  return {
    run: (argv, init) => $.process.run(argv, init),
    // Each name literal, so the engine lists the variables the module reads.
    env: name => (name === 'TMPDIR' ? $.env.get('TMPDIR') : name === 'HOME' ? $.env.get('HOME') : $.env.get('PATH')),
    exists: path => $.fs.exists(path),
    read: path => $.fs.read(path).catch(() => undefined),
    readBytes: path => $.fs.read(path, { as: 'bytes' }),
    write: (path, text) => $.fs.write(path, text),
    list: path => $.fs.list(path),
    sessionId: () => $.session.id(),
    project: () => project,
    pid: () => pid,
    // Waits go through a host process, which does not use up the hook's clock budget as a timer would.
    sleep: ms => $.process.run(['sleep', String(Math.ceil(ms / 1000))], { timeoutMs: ms + 10_000 }),
    status: text => $.ui.status(text),
    toast: text => $.ui.toast(text),
    submit: text => $.prompt.submit({ text }),
  }
}

/** The jobs an earlier version kept in `$.store`, which session start moves to the job files. */
function oldStoreOf($: EngineInterface): JobStore {
  return { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key), keys: () => $.store.keys() }
}

export const register: Register = (on, options) => {
  settings = settingsOf(options)

  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'antigravity:ask', text: PROMPT, scope: 'session' as const }] }
  })

  // The names stay literal in each call: the engine's scan reads them to classify the command hooks below.
  on('session.start', async ($, e, next) => {
    project = e.cwd
    await $.command.register({ name: 'antigravity-ask', description: ASK_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'antigravity-image', description: IMAGE_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'antigravity-review', description: REVIEW_COMMAND_DESCRIPTION })
    await $.command.register({ name: 'antigravity-doctor', description: DOCTOR_COMMAND_DESCRIPTION })
    // Jobs outlive a reload and the session: watch this session's again and finish what others left, without holding
    // the start up; then look for the jobs the MCP server hands off.
    void (async () => {
      pid = await claudePid($)
      await service.resume(hostOf($), oldStoreOf($)).catch(() => undefined)
      $.clock.every(PICK_UP_MS, () => void service.pickUp(hostOf($)).catch(() => undefined))
    })()
    return next(e)
  })

  on('command.run', { command: 'antigravity-ask' }, async ($, e) => service.ask(hostOf($), e.args))

  on('command.run', { command: 'antigravity-image' }, async ($, e) => service.image(hostOf($), e.args))

  on('command.run', { command: 'antigravity-review' }, async ($, e) => service.review(hostOf($), e.args))

  on('command.run', { command: 'antigravity-doctor' }, async $ => service.doctor(hostOf($)))
}
