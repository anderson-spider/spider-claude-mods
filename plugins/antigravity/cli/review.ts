// Git for the tasks: the project's root, a review's target, the throwaway worktree a review runs in (so the checkout is
// never touched), and the findings agy returns. ACP has no --json-schema, so the findings come back as a JSON block in
// the answer and are checked here. Git runs with core.fsmonitor off and diffs without external diff or textconv: a
// repository's config could otherwise name commands to run.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from './process.ts'

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']

export interface GitResult {
  code: number | null
  stdout: string
  stderr: string
}

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  return runProcess(['git', '-C', cwd, ...SAFE, ...args], { timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }).then(run => ({
    code: run.spawnError ? null : run.code,
    stdout: run.stdout,
    stderr: run.spawnError ?? run.stderr,
  }))
}

const why = (result: GitResult) => result.stderr.trim().split('\n')[0] || `exit code ${result.code}`

/** The repository's top folder, or undefined outside a git repository. */
export async function projectRoot(cwd: string): Promise<string | undefined> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel'])
  return top.code === 0 && top.stdout.trim() ? top.stdout.trim() : undefined
}

export type Target = { base: string } | { commit: string }

/** The git range a target covers: the branch since its merge base with the base, or one commit. */
export const rangeOf = (target: Target) => ('base' in target ? `${target.base}...HEAD` : `${target.commit}^!`)

// A ref as a person types it; anything else (an option, a range, odd characters) is refused before git sees it.
const REF = /^(?!-)[A-Za-z0-9._\/@{}~^-]+$/

/** The target a review covers: the commit or base given, else the branch against origin/HEAD, else main or master. */
export async function resolveTarget(project: string, given: { base?: string; commit?: string }): Promise<Target | { error: string }> {
  if (given.base && given.commit) return { error: 'Give --base or --commit, not both.' }
  const ref = given.commit ?? given.base
  if (ref !== undefined && !REF.test(ref)) return { error: `${ref} is not a git ref.` }
  if (given.commit) {
    const sha = await git(project, ['rev-parse', '--verify', '--quiet', `${given.commit}^{commit}`])
    return sha.code === 0 ? { commit: sha.stdout.trim() } : { error: `${given.commit} is not a commit here.` }
  }
  if (given.base) {
    const known = await git(project, ['rev-parse', '--verify', '--quiet', `${given.base}^{commit}`])
    return known.code === 0 ? { base: given.base } : { error: `${given.base} is not a branch or commit here.` }
  }
  const head = await git(project, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head.code === 0 && head.stdout.trim()) return { base: head.stdout.trim() }
  for (const branch of ['main', 'master']) if ((await git(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) return { base: branch }
  return { error: 'No default branch found (origin/HEAD, main or master): pass --base.' }
}

/** The diff file a review's worktree holds, named in its prompt. */
export const DIFF_FILE = '.agy-review.diff'

export interface ReviewWorktree {
  path: string
  range: string
  files: string[]
  diffPath: string
  /** Files git does not track, which a branch review leaves out. */
  untracked: number
}

/** Makes the review's worktree at HEAD (or the commit), detached, with the diff written into it. */
export async function makeReviewWorktree(project: string, path: string, target: Target): Promise<ReviewWorktree | { error: string }> {
  const range = rangeOf(target)
  const names = await git(project, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', range])
  if (names.code !== 0) return { error: `git could not diff ${range}: ${why(names)}` }
  const files = names.stdout.split('\n').filter(Boolean)
  if (files.length === 0) return { error: `Nothing to review: ${range} changes no file.` }
  const diff = await git(project, ['diff', '--no-ext-diff', '--no-textconv', range], 120_000)
  if (diff.code !== 0) return { error: `git could not diff ${range}: ${why(diff)}` }
  const added = await git(project, ['worktree', 'add', '--detach', '--lock', path, 'commit' in target ? target.commit : 'HEAD'], 300_000)
  if (added.code !== 0) return { error: `git could not make the review worktree: ${why(added)}` }
  const diffPath = join(path, DIFF_FILE)
  await writeFile(diffPath, diff.stdout, { mode: 0o600 })
  let untracked = 0
  if ('base' in target) {
    const listed = await git(project, ['ls-files', '--others', '--exclude-standard'])
    untracked = listed.code === 0 ? listed.stdout.split('\n').filter(Boolean).length : 0
  }
  return { path, range, files, diffPath, untracked }
}

/** Removes a task's worktree; a folder git no longer knows goes all the same. */
export async function removeWorktree(project: string, path: string): Promise<void> {
  const removed = await git(project, ['worktree', 'remove', '--force', '--force', path])
  if (removed.code !== 0) await runProcess(['rm', '-rf', '--', path], { timeoutMs: 60_000 })
  await git(project, ['worktree', 'prune'])
}

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
export interface Finding {
  priority: (typeof PRIORITIES)[number]
  title: string
  path: string
  line: number
  detail: string
}

/** The review's instructions: the diff file and its files, the scale, the JSON block to answer with, and the focus. */
export function reviewPrompt(review: ReviewWorktree, focus: string): string {
  return [
    `Review the code changes of this git repository (${review.range}). The full diff is in ${DIFF_FILE} in the current folder; the changed files are:`,
    ...review.files.map(path => `- ${path}`),
    '',
    'Read the diff, then the surrounding code in this folder as needed. Report only real problems, most severe first.',
    'P0 breaks the build, loses data or opens a security hole; P1 is a bug users hit; P2 a bug in an edge case or a missing check at a real boundary; P3 a minor correctness or clarity issue worth fixing.',
    'Put correctness and security first. Leave out style, naming and formatting comments.',
    '',
    'End your answer with one fenced ```json block holding exactly {"findings": [...]}, each finding',
    '{"priority": "P0"|"P1"|"P2"|"P3", "title": "<short>", "path": "<relative to the repository root>", "line": <line in the changed file>, "detail": "<one or two sentences: what goes wrong and when>"}.',
    'If you find nothing, the block is {"findings": []}: that is a valid answer.',
    ...(focus.trim() ? ['', 'The person asking adds:', focus.trim()] : []),
  ].join('\n')
}

/** The findings in an answer's last ```json block, checked; an error when there is none or it does not fit. */
export function findingsOf(answer: string): Finding[] | { error: string } {
  const blocks = [...answer.matchAll(/```json\s*\n([\s\S]*?)```/g)]
  const last = blocks.at(-1)?.[1]
  if (last === undefined) return { error: 'The answer has no ```json findings block.' }
  let parsed: any
  try {
    parsed = JSON.parse(last)
  } catch {
    return { error: 'The findings block is not valid JSON.' }
  }
  if (!Array.isArray(parsed?.findings)) return { error: 'The findings block has no findings list.' }
  const findings: Finding[] = []
  for (const [index, item] of parsed.findings.entries()) {
    const ok =
      (PRIORITIES as readonly string[]).includes(item?.priority) &&
      typeof item.title === 'string' && item.title.trim() &&
      typeof item.path === 'string' && item.path.trim() && !item.path.startsWith('/') &&
      Number.isInteger(item.line) && item.line >= 0 &&
      typeof item.detail === 'string'
    if (!ok) return { error: `Finding ${index + 1} does not fit the schema.` }
    findings.push({ priority: item.priority, title: item.title.trim(), path: item.path.trim(), line: item.line, detail: item.detail.trim() })
  }
  return findings.sort((a, b) => a.priority.localeCompare(b.priority))
}

export const findingLine = (finding: Finding) => `[${finding.priority}] ${finding.title} — ${finding.path}:${finding.line}`
