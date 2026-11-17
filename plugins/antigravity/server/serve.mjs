// The server's wiring, imported by main.mjs once Node resolves hooks/ imports: the options from the environment, the
// session from Claude Code's, and each tool call answered by the service on the Node host.
import { createInterface } from 'node:readline'
import { TOOLS, createService } from '../hooks/service'
import { settingsOf } from '../hooks/settings'
import { nodeHost } from './host.mjs'
import { server } from './mcp.mjs'

/**
 * @import { ToolAnswer, ToolName } from '../hooks/service'
 * @import { Content, Reply } from './mcp.mjs'
 */

// The plugin's options, as .mcp.json sets them from `${user_config.*}`: an option that is not set arrives empty, or
// as the placeholder itself where Claude Code leaves it unexpanded.
const OPTIONS = {
  foregroundMinutes: 'SPIDER_ANTIGRAVITY_OPTION_FOREGROUND_MINUTES',
  backgroundMinutes: 'SPIDER_ANTIGRAVITY_OPTION_BACKGROUND_MINUTES',
  agyPath: 'SPIDER_ANTIGRAVITY_OPTION_AGY_PATH',
  defaultModel: 'SPIDER_ANTIGRAVITY_OPTION_DEFAULT_MODEL',
}

/**
 * The options from `env`, which loses them, so a child process (git, agy) does not inherit them.
 * @param {Record<string, string | undefined>} env
 */
export function optionsFrom(env) {
  /** @type {Record<string, string>} */
  const options = {}
  for (const [option, name] of Object.entries(OPTIONS)) {
    const value = env[name]
    if (value && !value.startsWith('${')) options[option] = value
    delete env[name]
  }
  return options
}

/**
 * A tool's answer as MCP content: the text, and an image request's previews as images.
 * @param {ToolAnswer} answer
 * @returns {Reply}
 */
export function replyOf(answer) {
  const parts = typeof answer.result === 'string' ? [{ type: /** @type {const} */ ('text'), text: answer.result }] : answer.result
  /** @type {Content[]} */
  const content = parts.map((part) => (part.type === 'image' ? { type: 'image', data: part.source.data, mimeType: part.source.media_type } : part))
  return { content, ...(answer.isError ? { isError: /** @type {const} */ (true) } : {}) }
}

export function start() {
  const settings = settingsOf(optionsFrom(process.env))
  const service = createService(() => settings)
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? ''

  const mcp = server({
    tools: TOOLS,
    write: (line) => process.stdout.write(`${line}\n`),
    log: (text) => process.stderr.write(`${text}\n`),
    call: async (name, input, context) =>
      replyOf(await service.tool(nodeHost({ project, pid: process.ppid, sessionId, progress: context.progress }), /** @type {ToolName} */ (name), input)),
  })

  createInterface({ input: process.stdin }).on('line', (line) => {
    void mcp.receive(line)
  })
}
