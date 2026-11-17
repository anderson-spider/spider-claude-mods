// The secrets MCP server: started by Claude Code from .mcp.json, as a child of the Claude Code process, whose id names
// the session's queue (the hooks module finds the same id as the parent of a command it runs).
// The Node side is plain JavaScript typed by JSDoc (tsconfig.node.json checks it): `claude plugin validate` reads the
// TypeScript a plugin runs as hooks-module code, which has no Node.
import { createInterface } from 'node:readline'
import { ask } from './ask.mjs'
import { server } from './mcp.mjs'
import { nodeDeps } from './node.mjs'
import { REQUEST_SECRET } from './tool.mjs'

// Every file and folder the server makes is the owner's alone
process.umask(0o077)

const deps = nodeDeps({ home: process.env.HOME || undefined, configDir: process.env.CLAUDE_CONFIG_DIR || undefined }, process.ppid)

const mcp = server({
  tools: [REQUEST_SECRET],
  write: (line) => process.stdout.write(`${line}\n`),
  log: (text) => process.stderr.write(`${text}\n`),
  call: (_name, input) => ask(deps, input),
})

createInterface({ input: process.stdin }).on('line', (line) => {
  void mcp.receive(line)
})
