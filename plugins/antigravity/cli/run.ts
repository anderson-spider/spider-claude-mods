// `run` and `follow`: one delegated task, from the brief to the saved answer. A task gets its own folder, runs agy over
// ACP in the private agy home with every action answered by the mode, and prints a short summary that Claude reads when
// the background command ends. A follow-up resumes the same agy session.
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runTurn } from './acp.ts'
import { PROFILE, agyEnv, locateAgy, pathsOf, prepareHome } from './agy.ts'
import { classify } from './errors.ts'
import { headOf, makeTaskWorktree, patchOf, uncommittedOf } from './implement.ts'
import { decide, type Mode, type Scope } from './policy.ts'
import { bucketLine, bucketsFor, gateOf, readUsage } from './quota.ts'
import { findingLine, findingsOf, makeReviewWorktree, projectRoot, removeWorktree, resolveTarget, reviewPrompt } from './review.ts'
import { alive, createTaskDir, loadTask, lockSession, newTaskId, pruneTasks, saveTask, writeJson, type Role, type Status, type Task } from './tasks.ts'

export interface RunIo {
  out: (text: string) => void
  err: (text: string) => void
  env: NodeJS.ProcessEnv
  now: () => number
  cwd: string
  /** Aborted when the command is stopped (Claude Code stops a background command with SIGTERM). */
  signal?: AbortSignal
}

export interface RunArgs {
  mode: Mode
  role: Role
  briefFile: string
  model?: string
  effort?: string
  base?: string
  commit?: string
  minutes: number
  idleMinutes: number
  force: boolean
  agyPath?: string
  json: boolean
  /** The task a follow-up goes on from. */
  follow?: string
}

/** Exit codes past main's: the task wants a broader mode, or it was stopped. */
export const RUN_EXIT = { ok: 0, failed: 1, usage: 2, unavailable: 3, needsApproval: 4, cancelled: 130 } as const

const MAX_BRIEF = 200_000
// How much of the answer the summary prints; the whole answer is in the task folder.
const SHOWN = 20_000

const ROLE_LEAD: Record<Role, string> = {
  ask: 'Another AI agent (Claude), working for a person, asks you for a second opinion. Answer the brief below.',
  analysis: 'Another AI agent (Claude), working for a person, delegates this analysis to you. Read what you need and answer the brief below.',
  search: 'Another AI agent (Claude), working for a person, delegates this research to you. Use your web search tool, and give the source URL for every claim.',
  review: '',
}

const IMPLEMENT_LEAD =
  'Another AI agent (Claude), working for a person, delegates this change to you. The current folder is a throwaway copy of the repository: make the change there, in full. Your edits come back as a patch that Claude reviews and applies, so leave no file half done. End with a short summary of what you changed and what is left to check.'

/** The rules every prompt ends with: what the client allows, so agy does not spend turns on refused actions. */
export function rulesOf(mode: Mode, cwd: string): string {
  if (mode === 'read-only') {
    return `Client rules, enforced on every action: you may read files only inside ${cwd}. Creating, editing, deleting or moving files and running commands are refused. Do not try them; answer in text.`
  }
  return `Client rules, enforced on every action: you may read and edit files only inside ${cwd}. Running commands is refused. Do not try it; say in your answer what should be run.`
}

const plugin = async (): Promise<string> =>
  readFile(join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8').then(text => String(JSON.parse(text).version ?? '0'), () => '0')

const seconds = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`)

// One task's record is written by its turn's progress and by its end: each save waits for the one before, so an early
// progress save never lands after the final record.
const saving = new WeakMap<Task, Promise<void>>()
function save(task: Task): Promise<void> {
  const next = (saving.get(task) ?? Promise.resolve()).then(() => saveTask(task)).catch(() => undefined)
  saving.set(task, next)
  return next
}

export async function runTask(io: RunIo, args: RunArgs): Promise<number> {
  const brief = await readFile(args.briefFile, 'utf8').catch(() => undefined)
  if (brief === undefined) return usage(io, `Cannot read the brief ${args.briefFile}.`)
  if (!brief.trim()) return usage(io, 'The brief is empty: write the whole task in it, since agy does not see this conversation.')
  if (brief.length > MAX_BRIEF) return usage(io, `The brief is over ${MAX_BRIEF} characters; point agy at files instead of pasting them.`)

  const paths = pathsOf(io.env)
  let parent: Task | undefined
  if (args.follow) {
    const loaded = await loadTask(paths.tasks, args.follow)
    if (!('id' in loaded)) return usage(io, loaded.error)
    if (!loaded.sessionId) return usage(io, `Task ${loaded.id} has no agy session to follow up (it failed before one started); start a new task.`)
    // A first task holds no session lock (it has no session until agy starts one): its record says it still runs.
    if (loaded.status === 'running' && alive(loaded.pid)) return fail(io, `Task ${loaded.id} is still running on this agy session; follow up once it ends.`, RUN_EXIT.failed)
    parent = loaded
  }

  const agy = await locateAgy(args.agyPath, io.env)
  if (typeof agy !== 'string') return fail(io, agy.error, RUN_EXIT.unavailable)
  const refused = await prepareHome(paths)
  if (refused) return fail(io, refused, RUN_EXIT.failed)
  const warnings: string[] = []
  const model = args.model ?? parent?.model
  const usageNow = await readUsage(agy, paths.tasks, io.env)
  if (Array.isArray(usageNow)) {
    const gate = gateOf(bucketsFor(usageNow, model))
    if (gate.lowest && gate.verdict !== 'ok') {
      const line = bucketLine(gate.lowest, io.now())
      if (gate.verdict === 'refuse' && !args.force) return fail(io, `Not started: agy's quota is nearly spent (${line}). Pass --force to start anyway.`, RUN_EXIT.failed)
      warnings.push(`Low quota: ${line}.`)
    }
  } else warnings.push(`The quota could not be read (${usageNow.error}); the task started anyway.`)

  const repository = parent ? undefined : await projectRoot(io.cwd)
  const project = parent?.project ?? repository ?? io.cwd
  const role: Role = parent ? (args.role === 'review' ? 'ask' : args.role) : args.role
  if (args.mode === 'implement' && role === 'review') return usage(io, 'A review is read-only: run it with --mode read-only.')
  const now = new Date(io.now())
  const id = newTaskId(now)
  await pruneTasks(paths.tasks, io.now(), parent ? [parent.id] : [])
  const files = await createTaskDir(paths.tasks, id, brief)
  const task: Task = {
    id,
    ...(parent ? { parent: parent.id } : {}),
    mode: args.mode,
    role,
    project,
    cwd: project,
    ...(model ? { model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    status: 'running',
    pid: process.pid,
    startedAt: now.toISOString(),
    ...(parent?.sessionId ? { sessionId: parent.sessionId } : {}),
    refused: [],
    notes: [...warnings],
    files,
  }
  // The parent's patch is copied in, so this task keeps it when the parent's folder is pruned.
  if (parent?.files.patch) {
    const copied = join(paths.tasks, id, 'patch.diff')
    if (!(await copyFile(parent.files.patch, copied).then(() => true, () => false))) return finish(io, task, args, 'failed', `Task ${parent.id}'s patch is gone; start a new task.`, RUN_EXIT.failed)
    task.files.patch = copied
    if (parent.changed) task.changed = parent.changed
  }
  await save(task)

  // Where agy runs: a review's worktree at the reviewed commit, an implement task's (or a follow-up of one) at HEAD
  // with the earlier patch applied, else the checkout itself, read-only. From here on the worktree goes whatever happens.
  let worktree: string | undefined
  let gitDir: string | undefined
  let release: (() => Promise<void>) | undefined
  try {
    let prompt: string
    const inWorktree = args.mode === 'implement' || task.files.patch !== undefined
    if (role === 'review' && !parent) {
      if (!repository) return await finish(io, task, args, 'failed', 'A review needs a git repository.', RUN_EXIT.usage)
      const target = await resolveTarget(project, { ...(args.base ? { base: args.base } : {}), ...(args.commit ? { commit: args.commit } : {}) })
      if ('error' in target) return await finish(io, task, args, 'failed', target.error, RUN_EXIT.usage)
      worktree = join(paths.worktrees, id)
      const made = await makeReviewWorktree(project, worktree, target)
      if ('error' in made) return await finish(io, task, args, 'failed', made.error, RUN_EXIT.failed)
      task.cwd = made.path
      task.range = made.range
      if (made.untracked) task.notes.push(`${made.untracked} untracked ${made.untracked === 1 ? 'file was' : 'files were'} not reviewed; commit them to include them.`)
      prompt = reviewPrompt(made, brief)
    } else if (inWorktree) {
      const base = parent?.base ?? (await headOf(project))
      if (typeof base !== 'string') return await finish(io, task, args, 'failed', base.error, RUN_EXIT.usage)
      worktree = join(paths.worktrees, id)
      task.cwd = worktree
      task.base = base
      const made = await makeTaskWorktree(project, worktree, base, task.files.patch)
      if ('error' in made) return await finish(io, task, args, 'failed', made.error, RUN_EXIT.failed)
      gitDir = made.gitDir
      if (!parent?.base) {
        const dirty = await uncommittedOf(project)
        if (dirty) task.notes.push(`${dirty} uncommitted ${dirty === 1 ? 'change in your checkout is' : 'changes in your checkout are'} not in agy's copy, which starts at HEAD; the patch may need --3way to apply.`)
      }
      const lead = parent ? (task.files.patch ? `Your earlier changes were applied in a fresh copy of the repository at ${worktree}; work there from now on.` : `You now work in a copy of the repository at ${worktree}.`) : IMPLEMENT_LEAD
      prompt = `${lead}\n\n${brief}`
    } else prompt = parent ? brief : `${ROLE_LEAD[role]}\n\n${brief}`
    prompt = `${prompt}\n\n${rulesOf(args.mode, task.cwd)}`
    await save(task)

    if (task.sessionId) {
      const locked = await lockSession(join(paths.state, 'locks'), task.sessionId, id)
      if ('error' in locked) return await finish(io, task, args, 'failed', locked.error, RUN_EXIT.failed)
      release = locked
    }
    const scope: Scope = { cwd: task.cwd, readRoots: [task.cwd, paths.geminiDir], writeRoots: args.mode === 'implement' && worktree ? [worktree] : [] }
    const started = io.now()
    const turn = await runTurn({
      argv: [agy, 'acp', `--gemini-dir=${paths.geminiDir}`, `--cli_dir_name=${PROFILE}`, '--disable-telemetry'],
      cwd: task.cwd,
      env: agyEnv(io.env),
      prompt,
      ...(task.sessionId ? { resumeSessionId: task.sessionId } : {}),
      ...(model ? { model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      decide: toolCall => decide(args.mode, scope, toolCall),
      deadlineMs: args.minutes * 60_000,
      idleMs: args.idleMinutes * 60_000,
      ...(io.signal ? { signal: io.signal } : {}),
      onUpdate: update => {
        if (update.sessionId && update.sessionId !== task.sessionId) {
          task.sessionId = update.sessionId
          // The record names the session as soon as there is one, so a stopped task can still be followed up.
          void save(task)
        }
        if (update.executedModel !== undefined) task.executedModel = update.executedModel
      },
      clientVersion: await plugin(),
    })
    task.refused = turn.refused
    if (turn.sessionId) task.sessionId = turn.sessionId
    // A resumed session may not say its model; it keeps the one the earlier task ran.
    task.executedModel = turn.executedModel ?? parent?.executedModel ?? null
    const took = seconds(io.now() - started)
    if (turn.answer) {
      task.files.answer = join(paths.tasks, id, 'answer.md')
      await writeFile(task.files.answer, `${turn.answer}\n`, { mode: 0o600 })
    }
    if (turn.status === 'completed' && task.role === 'review' && !parent) {
      const findings = findingsOf(turn.answer)
      if (Array.isArray(findings)) {
        task.findings = findings
        task.files.findings = join(paths.tasks, id, 'findings.json')
        await writeJson(task.files.findings, findings)
      } else task.notes.push(`${findings.error} The answer is saved as agy wrote it.`)
    }
    // The patch is kept whatever the end, a stopped or failed task's too: it holds the work done so far.
    if (args.mode === 'implement' && worktree && gitDir && task.base) {
      const patch = await patchOf(worktree, gitDir, task.base)
      if ('error' in patch) task.notes.push(`${patch.error} agy's changes are lost.`)
      else if (patch.changed.length === 0) {
        task.notes.push('agy changed no file.')
        // A follow-up whose changes cancel out the earlier ones leaves no patch, not the copied one.
        delete task.changed
        if (task.files.patch) await rm(task.files.patch, { force: true })
        delete task.files.patch
      } else {
        task.changed = patch.changed
        task.files.patch = join(paths.tasks, id, 'patch.diff')
        await writeFile(task.files.patch, patch.diff, { mode: 0o600 })
        if (turn.status !== 'completed') task.notes.push('The patch holds the changes made before the task ended.')
      }
    }
    if (worktree) task.notes.push(`agy's worktree was removed; your checkout was not touched.`)
    if (turn.status === 'completed') return await finish(io, task, args, 'completed', undefined, RUN_EXIT.ok, took)
    const failure = classify(turn, io.now())
    task.reason = failure.reason
    if (failure.reason === 'cancelled') return await finish(io, task, args, 'cancelled', failure.message, RUN_EXIT.cancelled, took)
    if (failure.reason === 'no answer' && turn.refused.length > 0) return await finish(io, task, args, 'needs_approval', 'agy stopped at actions this mode refuses and gave no answer.', RUN_EXIT.needsApproval, took)
    return await finish(io, task, args, 'failed', failure.message, RUN_EXIT.failed, took)
  } catch (error) {
    return await finish(io, task, args, 'failed', `The task broke: ${error instanceof Error ? error.message : String(error)}`, RUN_EXIT.failed)
  } finally {
    await release?.()
    if (worktree) await removeWorktree(project, worktree)
  }
}

async function finish(io: RunIo, task: Task, args: RunArgs, status: Status, error: string | undefined, code: number, took?: string): Promise<number> {
  task.status = status
  task.endedAt = new Date(io.now()).toISOString()
  delete task.pid
  if (error) task.error = error
  await save(task)
  if (args.json) {
    io.out(JSON.stringify(task, null, 2))
    return code
  }
  const lines = [`agy task ${task.id} ${status.replace('_', ' ')}${task.executedModel ? ` (model ${task.executedModel}${took ? `, ${took}` : ''})` : took ? ` (${took})` : ''}`]
  if (error) lines.push(error)
  for (const note of task.notes) lines.push(`Note: ${note}`)
  if (task.refused.length) lines.push(`Refused by the ${task.mode} mode:`, ...task.refused.map(r => `- ${r.kind}: ${r.title} (${r.reason})`))
  if (task.sessionId && status !== 'running') lines.push(`Follow up: antigravity-delegate follow --task ${task.id} --brief-file <file>`)
  lines.push(`Task folder: ${task.files.record.replace(/\/task\.json$/, '')}`)
  if (task.files.patch && task.changed) {
    lines.push('', `Patch: ${task.files.patch} (${task.changed.length} ${task.changed.length === 1 ? 'file' : 'files'}, against ${task.base?.slice(0, 12) ?? 'HEAD'})`, ...task.changed.map(line => `  ${line.replace('\t', ' ')}`))
    lines.push(`Apply it: git -C ${task.project} apply --3way ${task.files.patch}`)
  }
  if (task.findings) lines.push('', task.findings.length ? `Findings (${task.findings.length}):` : 'No findings.', ...task.findings.map(findingLine), `Findings file: ${task.files.findings}`)
  if (task.files.answer) {
    const answer = await readFile(task.files.answer, 'utf8').catch(() => '')
    lines.push('', `agy's answer (${task.files.answer}):`, '', answer.length > SHOWN ? `${answer.slice(0, SHOWN)}\n\n[cut at ${SHOWN} characters; the whole answer is in the file]` : answer.trimEnd())
  }
  io.out(lines.join('\n'))
  return code
}

function usage(io: RunIo, message: string): number {
  io.err(message)
  return RUN_EXIT.usage
}

function fail(io: RunIo, message: string, code: number): number {
  io.err(message)
  return code
}
