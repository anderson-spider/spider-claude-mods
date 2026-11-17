// The orchestrator's MCP server: started by Claude Code from .mcp.json, one per session, with the plugin's options in
// its environment. It owns no task: it forwards each tool call, with the session's id, folder and options, to the
// shared daemon (daemon/main.mjs), which runs the tasks and outlives the session.
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { stateDirOf } from '../hooks/paths.ts'
import { isRuntimeMode } from '../daemon/policy.mjs'
import { socketPathOf, versionOf } from '../daemon/socket.mjs'
import { daemonClient } from './daemon-client.mjs'
import { server } from './mcp.mjs'
import { TOOLS } from './tools.ts'

/** @import { Settings } from '../daemon/orchestrator.mjs' */

// The plugin's options, as .mcp.json sets them from `${user_config.*}`: an unset one arrives empty, or as the
// placeholder itself where Claude Code leaves it unexpanded.
const OPTIONS = {
  agyPath: 'SPIDER_ORCHESTRATOR_OPTION_AGY_PATH',
  maxRuntimeMode: 'SPIDER_ORCHESTRATOR_OPTION_MAX_RUNTIME_MODE',
  taskMinutes: 'SPIDER_ORCHESTRATOR_OPTION_TASK_MINUTES',
}
const DEFAULT_RUNTIME_MODE = 'auto-accept-edits'
const DEFAULT_TASK_MINUTES = 30
// A progress beat while a wait holds the call, so the client keeps it open.
const BEAT_MS = 5_000

/**
 * The settings from `env`, which loses the options, so the daemon and agy do not inherit them.
 * @param {Record<string, string | undefined>} env
 * @returns {Settings}
 */
export function settingsFrom(env) {
  /** @type {Record<string, string>} */
  const raw = {}
  for (const [option, name] of Object.entries(OPTIONS)) {
    const value = env[name]?.trim()
    if (value && !value.startsWith('${')) raw[option] = value
    delete env[name]
  }
  const minutes = Number(raw.taskMinutes)
  const mode = raw.maxRuntimeMode
  return {
    ...(raw.agyPath ? { agyPath: raw.agyPath } : {}),
    maxRuntimeMode: isRuntimeMode(mode) ? mode : DEFAULT_RUNTIME_MODE,
    taskMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) : DEFAULT_TASK_MINUTES,
  }
}

async function start() {
  const env = { ...process.env }
  const settings = settingsFrom(env)
  const stateDir = stateDirOf(env.HOME || homedir(), env.XDG_STATE_HOME)
  const daemon = daemonClient({ stateDir, socketPath: socketPathOf(stateDir, await versionOf()), env })
  const caller = { sessionId: env.CLAUDE_CODE_SESSION_ID ?? '', cwd: env.CLAUDE_PROJECT_DIR || process.cwd(), settings }

  const mcp = server({
    tools: TOOLS,
    write: (line) => process.stdout.write(`${line}\n`),
    log: (text) => process.stderr.write(`${text}\n`),
    async call(name, input, context) {
      if (!caller.sessionId) return { content: [{ type: 'text', text: 'The orchestrator needs the Claude Code session id (CLAUDE_CODE_SESSION_ID), which this server did not get.' }], isError: true }
      const beat = setInterval(() => context.progress('the delegated task is working'), BEAT_MS)
      try {
        const result = await daemon.request(name, { caller, input })
        const failed = typeof result === 'object' && result !== null && 'error' in result
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(failed ? { isError: /** @type {const} */ (true) } : {}) }
      } finally {
        clearInterval(beat)
      }
    },
  })
  createInterface({ input: process.stdin }).on('line', (line) => void mcp.receive(line))
}

await start()
