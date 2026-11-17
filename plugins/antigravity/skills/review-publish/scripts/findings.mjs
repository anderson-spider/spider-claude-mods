#!/usr/bin/env node
// Check code-review findings against the diff and turn them into PR/MR comments. No dependencies.
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const HELP = `usage: findings.mjs {schema,check,github,gitlab} ...

Check code-review findings against the diff and turn them into PR/MR comments.

Run inside the repo. The diff is \`git diff -M -U3 <fixed-point>...HEAD\`, the hunks
a PR/MR shows: commits only, never uncommitted work. Git config that changes the
diff shape (context, prefixes, path quoting) is overridden.

schema prints the shape of a finding: fields, types, allowed values and an example.
check  prints one line per finding (ok / FAIL with the reason); exit 1 when any fails.
       findings.mjs check <fixed-point> <findings.json>
github prints a review payload for \`gh api repos/O/R/pulls/N/reviews --input -\`:
       no \`event\`, so the review stays PENDING. Findings that fail the check are
       left out and listed on stderr.
       findings.mjs github <fixed-point> <findings.json> --commit <sha> --body <text>
gitlab prints a JSON array of inputs for the gitlab plugin's
       \`mcp__plugin_gitlab_gitlab__gitlab_mr_comment\` tool, one call each: \`line\` draft notes
       ({action, draft, iid, path, line and/or oldLine, body}, plus host and
       project when given). The tool builds the position from the MR's diff refs;
       an unchanged line carries both line numbers. Failing findings go to stderr.
       findings.mjs gitlab <fixed-point> <findings.json> --iid <n> [--host <host>] [--project <path-or-id>]
`

/** Field name to the Python-style type name the messages and `schema` use. */
export const FIELDS = { path: 'str', line: 'int', side: 'str', severity: 'str', raisedBy: 'list', body: 'str' }
export const ENUMS = { side: new Set(['new', 'old']), severity: new Set(['blocker', 'major', 'minor', 'nit']) }
export const EXAMPLE = { path: 'src/a.ts', line: 42, side: 'new', severity: 'major', raisedBy: ['Gemini'], body: '…' }
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
// the line breaks Python's str.splitlines knows, so a diff splits the same way
const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]')

/** A refusal the CLI prints to stderr before exiting with `code`. */
export class FindingsError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Python's repr, for the messages ported from findings.py. */
export function pyRepr(v) {
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'"
    const body = v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    return q + (q === "'" ? body.replace(/'/g, "\\'") : body) + q
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`
}

/** Python's str: a string as it is, anything else as its repr. */
const pyStr = v => (typeof v === 'string' ? v : pyRepr(v))

function git(args, cwd) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Return the diff text to parse, or throw when the fixed point is unusable. */
export function obtainDiff(fixedPoint, cwd = process.cwd()) {
  if (fixedPoint.startsWith('-')) throw new FindingsError(`fixed point ${pyRepr(fixedPoint)} looks like an option`)
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${fixedPoint}^{commit}`], { cwd, stdio: 'ignore' }).status !== 0) {
    throw new FindingsError(`fixed point ${pyRepr(fixedPoint)} does not resolve to a commit`)
  }
  return git(['diff', '-M', '-U3', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `${fixedPoint}...HEAD`, '--'], cwd)
}

const ESCAPES = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39 }

/** Decode git's C-quoted path body: escapes and octal UTF-8 bytes. */
function cUnquote(s) {
  const bytes = []
  const raw = Buffer.from(s, 'utf8')
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== 92 || i + 1 >= raw.length) { bytes.push(raw[i]); continue }
    const c = String.fromCharCode(raw[i + 1])
    const octal = /^[0-7]{1,3}/.exec(raw.subarray(i + 1, i + 4).toString('latin1'))
    if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += octal[0].length }
    else if (c in ESCAPES) { bytes.push(ESCAPES[c]); i++ }
    else bytes.push(raw[i])
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Path of a `--- a/x` / `+++ b/x` line, or null for /dev/null. */
function headerPath(raw) {
  let name = raw.slice(4).split('\t', 1)[0]
  if (name.startsWith('"')) name = cUnquote(name.slice(1, -1))
  return name === '/dev/null' ? null : name.slice(2)
}

/**
 * Return a Map of path to file = {old, new, new_lines: Map<n, old_n|null>, removed: Set}.
 * Each file is reachable by its new path and, when renamed, by its old path too.
 */
export function parseDiff(diffText) {
  const files = new Map()
  let cur = null, inHunk = false, o = 0, n = 0
  const lines = diffText.split(LINE_BREAK)
  if (lines.at(-1) === '') lines.pop()
  for (const raw of lines) {
    let m
    if (raw.startsWith('diff --git ')) {
      cur = { old: null, new: null, new_lines: new Map(), removed: new Set() }
      inHunk = false
    } else if (cur === null) {
      continue
    } else if ((m = HUNK.exec(raw))) {
      o = Number(m[1]); n = Number(m[2]); inHunk = true
    } else if (!inHunk) {
      if (raw.startsWith('--- ')) cur.old = headerPath(raw)
      else if (raw.startsWith('+++ ')) {
        cur.new = headerPath(raw)
        for (const p of new Set([cur.old, cur.new])) if (p !== null) files.set(p, cur)
      }
    } else if (raw.startsWith('-')) {
      cur.removed.add(o); o++
    } else if (raw.startsWith('+')) {
      cur.new_lines.set(n, null); n++
    } else if (raw.startsWith(' ')) {
      cur.new_lines.set(n, o); o++; n++
    }
  }
  return files
}

function hasType(v, t) {
  if (t === 'str') return typeof v === 'string'
  if (t === 'int') return typeof v === 'number' && Number.isInteger(v)
  return Array.isArray(v)
}

/** Return null when the finding has the shape `schema` describes, else the reason. */
export function validateFields(f) {
  for (const [k, t] of Object.entries(FIELDS)) {
    if (!hasType(f[k], t)) return `field ${pyRepr(k)} missing or not ${t}`
  }
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (!allowed.has(f[k])) return `${k}=${pyRepr(f[k])} not in ${pyRepr([...allowed].sort())}`
  }
  return null
}

/** Return [file, null] when the finding sits on the diff, else [null, reason]. */
export function locate(f, files) {
  const reason = validateFields(f)
  if (reason) return [null, reason]
  const d = files.get(f.path)
  if (d === undefined) return [null, 'path not in the diff']
  const sidePath = f.side === 'new' ? d.new : d.old
  if (f.path !== sidePath) return [null, `a ${f.side} line takes the path ${pyRepr(sidePath)}`]
  if (f.side === 'new' && !d.new_lines.has(f.line)) return [null, 'new line not in a hunk']
  if (f.side === 'old' && !d.removed.has(f.line)) return [null, 'old line is not a removed line']
  return [d, null]
}

export function labelOf(f) {
  if (!isObject(f)) return pyRepr(f)
  return `${pyStr(f.side)} ${pyStr(f.path)}:${pyStr(f.line)}`
}

/** Return [finding, file, reason] in input order: reason is null when it sits on the diff. */
export function place(findings, files) {
  return findings.map(f => {
    const [d, reason] = isObject(f) ? locate(f, files) : [null, 'not an object']
    return [f, d, reason]
  })
}

export function githubPayload(placed, commit, body) {
  const comments = placed.map(([f, d]) => ({
    path: d.new ?? d.old, line: f.line, side: f.side === 'new' ? 'RIGHT' : 'LEFT', body: f.body,
  }))
  return { commit_id: commit, body, comments }
}

/**
 * Inputs for `mcp__plugin_gitlab_gitlab__gitlab_mr_comment`, one `line` draft note per finding. `path` is the finding's own
 * side path (the tool finds a renamed file's other path in the MR diff); an unchanged line carries both numbers.
 */
export function gitlabInputs(placed, { iid, host, project }) {
  return placed.map(([f, d]) => {
    const input = { action: 'line', draft: true }
    if (host !== undefined) input.host = host
    if (project !== undefined) input.project = project
    input.iid = iid
    input.path = f.path
    if (f.side === 'new') {
      input.line = f.line
      const old = d.new_lines.get(f.line)
      if (old !== null) input.oldLine = old
    } else {
      input.oldLine = f.line
    }
    input.body = f.body
    return input
  })
}

/** JSON on one line with Python's default separators (`, ` and `: `), as json.dumps prints it. */
function pyJsonLine(v) {
  if (Array.isArray(v)) return `[${v.map(pyJsonLine).join(', ')}]`
  if (isObject(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyJsonLine(x)}`).join(', ')}}`
  return JSON.stringify(v)
}

export function schemaText() {
  const lines = ['A findings file is a JSON array with one object per finding:']
  for (const [k, t] of Object.entries(FIELDS)) {
    const allowed = k in ENUMS ? `, one of ${[...ENUMS[k]].sort().join(', ')}` : ''
    lines.push(`  ${k}: ${t}${allowed}`)
  }
  lines.push('example:', pyJsonLine(EXAMPLE))
  return lines.join('\n')
}

export function loadFindings(path) {
  const findings = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(findings)) throw new FindingsError('findings file must hold a JSON array')
  return findings
}

const COMMANDS = {
  schema: { positionals: [], options: {} },
  check: { positionals: ['fixed_point', 'findings.json'], options: {} },
  github: { positionals: ['fixed_point', 'findings.json'], options: { commit: true, body: true } },
  gitlab: { positionals: ['fixed_point', 'findings.json'], options: { iid: true, host: false, project: false } },
}

/** Parse argv like argparse did: the subcommand, its positionals and `--name value` / `--name=value` options. */
export function parseArgs(argv) {
  const usage = message => new FindingsError(`${HELP.split('\n\n')[0]}\nfindings.mjs: error: ${message}`, 2)
  const [cmd, ...rest] = argv
  if (cmd === undefined) throw usage('the following arguments are required: command')
  if (cmd === '-h' || cmd === '--help') return { cmd: 'help' }
  const spec = COMMANDS[cmd]
  if (!spec) throw usage(`argument command: invalid choice: ${pyRepr(cmd)} (choose from ${Object.keys(COMMANDS).map(pyRepr).join(', ')})`)
  const positionals = [], options = {}
  let onlyPositionals = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (onlyPositionals || !arg.startsWith('--') || arg === '--') {
      if (arg === '--' && !onlyPositionals) { onlyPositionals = true; continue }
      if (!onlyPositionals && arg.startsWith('-') && arg.length > 1) throw usage(`unrecognized arguments: ${arg}`)
      positionals.push(arg)
      continue
    }
    if (arg === '--help') return { cmd: 'help' }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    if (!(name in spec.options)) throw usage(`unrecognized arguments: ${arg}`)
    let value
    if (eq !== -1) value = arg.slice(eq + 1)
    else if (i + 1 < rest.length) value = rest[++i]
    else throw usage(`argument --${name}: expected one argument`)
    options[name] = value
  }
  if (positionals.length > spec.positionals.length) throw usage(`unrecognized arguments: ${positionals.slice(spec.positionals.length).join(' ')}`)
  const missing = [
    ...spec.positionals.slice(positionals.length),
    ...Object.entries(spec.options).filter(([n, required]) => required && !(n in options)).map(([n]) => `--${n}`),
  ]
  if (missing.length) throw usage(`the following arguments are required: ${missing.join(', ')}`)
  if (options.iid !== undefined) {
    if (!/^\d+$/.test(options.iid) || Number(options.iid) < 1) throw usage(`argument --iid: invalid positive int value: ${pyRepr(options.iid)}`)
    options.iid = Number(options.iid)
  }
  return { cmd, fixedPoint: positionals[0], findings: positionals[1], ...options }
}

/** Run the CLI; returns the exit code, writing to the given streams. */
export function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  try {
    const args = parseArgs(argv)
    if (args.cmd === 'help') { stdout.write(HELP); return 0 }
    if (args.cmd === 'schema') { stdout.write(`${schemaText()}\n`); return 0 }
    const findings = loadFindings(args.findings)
    const files = parseDiff(obtainDiff(args.fixedPoint, cwd))
    const results = place(findings, files)
    const report = args.cmd === 'check' ? stdout : stderr
    for (const [f, , reason] of results) {
      if (reason) report.write(`FAIL ${labelOf(f)}: ${reason}\n`)
      else if (args.cmd === 'check') stdout.write(`ok   ${labelOf(f)}\n`)
    }
    const placed = results.filter(([, , reason]) => !reason).map(([f, d]) => [f, d])
    if (args.cmd === 'check') return placed.length < results.length ? 1 : 0
    const out = args.cmd === 'github'
      ? githubPayload(placed, args.commit, args.body)
      : gitlabInputs(placed, { iid: args.iid, host: args.host, project: args.project })
    stdout.write(`${JSON.stringify(out, null, 1)}\n`)
    return 0
  } catch (err) {
    if (!(err instanceof FindingsError)) throw err
    stderr.write(`${err.message}\n`)
    return err.code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
