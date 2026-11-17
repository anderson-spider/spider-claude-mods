// The fence as a PreToolUse command hook (hooks/hooks.json): Claude Code runs it before each call of the matched
// tools, the calls Code Mode's code makes included, with the hook input on stdin. It prints a deny, or nothing to let
// the call go on. It fails open (no output, and `onFailure: continue` in hooks.json), since the scrubber is the guarantee.
// Plain JavaScript typed by JSDoc (tsconfig.node.json checks it): `claude plugin validate` reads the TypeScript a hook
// command runs as hooks-module code, which has no Node.
import { readdir, readFile, stat } from 'node:fs/promises'
import { denyText, fenceReason } from '../hooks/guard.ts'
import { carries } from '../hooks/scrub.ts'
import { isExpired, nameOf, secretsDir } from '../hooks/store.ts'

/**
 * The live saved values: the files the plugin wrote, short of their day.
 * @param {string} dir
 * @param {number} now
 * @returns {Promise<string[]>}
 */
export async function liveValues(dir, now) {
  /** @type {string[]} */
  const values = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || nameOf(entry.name) === undefined) continue
    const path = `${dir}/${entry.name}`
    const info = await stat(path).catch(() => undefined)
    if (!info || isExpired(info.mtimeMs, now)) continue
    const value = await readFile(path, 'utf8').catch(() => undefined)
    if (value) values.push(value)
  }
  return values
}

/**
 * The hook's answer to one input: the deny to print, or undefined.
 * @param {string} raw
 * @param {{ home?: string, configDir?: string }} env
 * @param {number} now
 * @returns {Promise<string | undefined>}
 */
export async function decide(raw, env, now) {
  /** @type {{ tool_name?: unknown, tool_input?: unknown, cwd?: unknown }} */
  const input = JSON.parse(raw)
  const tool = typeof input.tool_name === 'string' ? input.tool_name : ''
  const args = input.tool_input && typeof input.tool_input === 'object' ? /** @type {Record<string, unknown>} */ (input.tool_input) : {}
  const dir = secretsDir(env)
  if (!tool || !dir) return undefined
  const cwd = typeof input.cwd === 'string' ? input.cwd : undefined
  // A call into the folder, or any matched call (a SendMessage to another agent included) that carries a saved value
  const reason =
    fenceReason(tool, args, dir, env.home, cwd) ?? (carries(args, await liveValues(dir, now)) ? 'it carries the value of a saved secret' : undefined)
  if (!reason) return undefined
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denyText(reason) } })
}

/** Reads the hook input on stdin and prints the deny, if any. */
async function main() {
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const env = { home: process.env.HOME || undefined, configDir: process.env.CLAUDE_CONFIG_DIR || undefined }
  const out = await decide(raw, env, Date.now()).catch(() => undefined)
  if (out) process.stdout.write(out)
}

if (import.meta.main) await main()
