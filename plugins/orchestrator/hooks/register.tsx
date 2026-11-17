import type { EngineInterface, Register } from 'claude-code'
import { noticeOf } from './inbox'
import { SESSION_ID, inboxDirOf, stateDirOf } from './paths'
import { PROMPT } from './prompt'

// The hooks module: the system prompt section, and the wake-up of this session when a task it delegated ends. The
// tools come from the MCP server (server/main.mjs) and the tasks run in the daemon, so the module registers no event
// that turns Code Mode off (tool.call, session.send and the like).

// How often the module looks for notices.
const POLL_MS = 2_000

// One delivery at a time: a slow one is not overtaken by the next tick.
let delivering = false

/** Submits each notice waiting for this session as a prompt, once: the file is removed before the prompt goes. */
async function deliver($: EngineInterface): Promise<void> {
  if (delivering) return
  delivering = true
  try {
    const sessionId = await $.session.id()
    const home = await $.env.get('HOME')
    if (!SESSION_ID.test(sessionId) || !home) return
    const dir = inboxDirOf(stateDirOf(home, await $.env.get('XDG_STATE_HOME')), sessionId)
    const entries = await $.fs.list(dir).catch(() => [])
    const files = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const entry of files) {
      const path = `${dir}/${entry.name}`
      const text = await $.fs.read(path).catch(() => undefined)
      const removed = await $.process.run(['rm', '-f', '--', path], { timeoutMs: 5_000 }).catch(() => undefined)
      const notice = text === undefined ? undefined : noticeOf(text)
      if (removed?.exitCode === 0 && notice) await $.prompt.submit({ text: notice.text })
    }
  } finally {
    delivering = false
  }
}

export const register: Register = on => {
  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'orchestrator:delegation', text: PROMPT, scope: 'session' as const }] }
  })

  on('session.start', async ($, e, next) => {
    $.clock.every(POLL_MS, () => void deliver($).catch(() => undefined))
    return next(e)
  })
}
