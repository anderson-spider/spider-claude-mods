// The gitlab MCP server: started by Claude Code from .mcp.json, which hands it the plugin's options in the environment.
import { createInterface } from 'node:readline'
import { server } from './mcp.ts'
import { nodeDeps } from './node.ts'
import { run } from './run.ts'
import { TOOLS } from './tools.ts'

/** The plugin's options, as .mcp.json sets them from `${user_config.*}`: an option that is not set arrives empty. */
const options = {
  tokens: process.env.SPIDER_GITLAB_OPTION_TOKENS || undefined,
  defaultHost: process.env.SPIDER_GITLAB_OPTION_DEFAULT_HOST || undefined,
}
// The options' values stay in this process only: a git or ssh child does not inherit them.
delete process.env.SPIDER_GITLAB_OPTION_TOKENS
delete process.env.SPIDER_GITLAB_OPTION_DEFAULT_HOST

const mcp = server({
  write: line => process.stdout.write(`${line}\n`),
  log: text => process.stderr.write(`${text}\n`),
  call: (name, input, context) =>
    run(nodeDeps(context.cwd ?? process.cwd(), () => context.progress('waiting')), TOOLS[name], input, options),
})

createInterface({ input: process.stdin }).on('line', line => { void mcp.receive(line) })
