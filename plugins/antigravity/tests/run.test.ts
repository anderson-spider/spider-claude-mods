import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { EXIT, cli, type Io } from '../cli/main.ts'
import { runTask } from '../cli/run.ts'
import type { Task } from '../cli/tasks.ts'
import { fakeAgyDir } from './fake-agy.ts'

const NOW = Date.parse('2026-11-18T11:55:00Z')

async function harness(script: object = {}, cwd?: string) {
  const dir = await fakeAgyDir()
  const state = await mkdtemp(join(tmpdir(), 'antigravity-state-'))
  const log = join(state, 'agent.log')
  const out: string[] = []
  const err: string[] = []
  const project = cwd ?? (await realpath(await mkdtemp(join(tmpdir(), 'antigravity-project-'))))
  const io: Io = {
    out: text => void out.push(text),
    err: text => void err.push(text),
    now: Date.now,
    cwd: project,
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: '/nonexistent', XDG_STATE_HOME: state, FAKE_AGENT_SCRIPT: JSON.stringify(script), FAKE_AGENT_LOG: log, GEMINI_API_KEY: 'must-not-reach-agy' },
  }
  const brief = join(state, 'brief.md')
  await writeFile(brief, 'Explain the retry loop in cli/acp.ts.')
  const entries = async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : [])
  const tasks = join(state, 'spider-antigravity', 'tasks')
  const record = async (): Promise<Task> => {
    // The newest task; ids started in the same second sort by their random part.
    const all: Task[] = await Promise.all((await readdir(tasks)).map(async id => JSON.parse(await readFile(join(tasks, id, 'task.json'), 'utf8'))))
    return all.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || (a.endedAt ?? '').localeCompare(b.endedAt ?? '')).at(-1) as Task
  }
  return { io, out, err, brief, entries, record, project, state }
}

const prompts = (entries: any[]) => entries.filter(entry => entry.got?.method === 'session/prompt').map(entry => entry.got.params.prompt[0].text as string)

test('run ask answers, in the project, through the private agy home, with the rules in the prompt', async () => {
  const h = await harness({ steps: [{ say: 'It retries after a refusal.' }] })
  assert.equal(await cli(['run', '--mode', 'read-only', '--role', 'ask', '--brief-file', h.brief, '--model', ''], h.io), EXIT.ok)
  const text = h.out.join('\n')
  assert.match(text, /^agy task \d{8}-\d{6}-[0-9a-f]{6} completed \(model gemini-4-argon-medium, \d+s\)$/m)
  assert.match(text, /^Note: Low quota: Gemini Models · 5-hour: 25% left/m)
  assert.match(text, /^Follow up: antigravity-delegate follow --task \S+ --brief-file <file>$/m)
  assert.match(text, /It retries after a refusal\.$/)
  const entries = await h.entries()
  const start = entries.find(entry => entry.start).start
  assert.equal(start.cwd, h.project)
  assert.ok(start.argv.some((arg: string) => arg === `--gemini-dir=${join(h.state, 'spider-antigravity', 'gemini')}`))
  assert.ok(start.argv.includes('--disable-telemetry'))
  assert.ok(!start.env.includes('GEMINI_API_KEY'), 'ambient Gemini variables are stripped')
  const [prompt] = prompts(entries)
  assert.match(prompt ?? '', /^Another AI agent \(Claude\)[\s\S]*Explain the retry loop[\s\S]*Client rules, enforced on every action: you may read files only inside /)
  const task = await h.record()
  assert.equal(task.status, 'completed')
  assert.equal(task.sessionId, '11111111-2222-3333-4444-555555555555')
  assert.equal(await readFile(task.files.answer ?? '', 'utf8'), 'It retries after a refusal.\n')
})

test('run read-only allows reads inside the project and refuses the rest, then prompts agy on', async () => {
  const h = await harness({
    steps: [{ permission: { kind: 'read', title: 'Read acp.ts', locations: [{ path: 'cli/acp.ts' }] } }, { permission: { kind: 'read', title: 'Read hosts', locations: [{ path: '/etc/hosts' }] } }, { permission: { kind: 'edit', title: 'Edit acp.ts', locations: [{ path: 'cli/acp.ts' }] } }],
    retrySteps: [[{ permission: { kind: 'execute', title: 'Run npm test' } }], [{ say: 'Answered without them.' }]],
  })
  assert.equal(await cli(['run', '--role', 'analysis', '--brief-file', h.brief], h.io), EXIT.ok)
  const answers = (await h.entries()).filter(entry => entry.permission).map(entry => entry.answer.outcome.optionId)
  assert.deepEqual(answers, ['allow', 'deny', 'deny', 'deny'])
  const text = h.out.join('\n')
  assert.match(text, /^Refused by the read-only mode:\n- read: Read hosts \(a read outside the task folder\)\n- edit: Edit acp\.ts \(read-only\)\n- execute: Run npm test \(commands are not allowed\)$/m)
  assert.match(text, /Answered without them\.$/)
})

test('run ends needs_approval when refusals leave no answer', async () => {
  const h = await harness({ steps: [{ permission: { kind: 'edit', title: 'Edit a file', locations: [{ path: 'a.txt' }] } }], retrySteps: [[{ permission: { kind: 'edit', title: 'Edit a file', locations: [{ path: 'a.txt' }] } }]] })
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.needsApproval)
  assert.match(h.out.join('\n'), /^agy task \S+ needs approval/m)
  const task = await h.record()
  assert.equal(task.status, 'needs_approval')
  assert.equal(task.refused.length, 5)
})

test('run refuses to start on a nearly spent quota unless forced', async () => {
  const h = await harness()
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief, '--model', 'gemini-4-argon-high'], h.io), EXIT.failed)
  assert.match(h.err.join('\n'), /^Not started: agy's quota is nearly spent \(Gemini 4 Argon · weekly: 8% left/)
  assert.deepEqual(await h.entries(), [])
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief, '--model', 'gemini-4-argon-high', '--force'], h.io), EXIT.ok)
  assert.ok((await h.entries()).some(entry => entry.got?.method === 'session/set_model' && entry.got.params.modelId === 'gemini-4-argon-high'))
})

test('run reports an unknown model, idle and agy errors as failures', async () => {
  const model = await harness()
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', model.brief, '--model', 'nope-1', '--force'], model.io), EXIT.failed)
  assert.match(model.out.join('\n'), /^agy failed \(model unavailable\): Unknown model ID: nope-1 antigravity-delegate models lists the ids\.$/m)
  const idle = await harness({ steps: [{ sleep: 5_000 }] })
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', idle.brief, '--idle-minutes', '0.002'], idle.io), EXIT.failed)
  assert.match(idle.out.join('\n'), /agy failed \(idle\)/)
  assert.equal((await idle.record()).reason, 'idle')
  const quota = await harness({ steps: [{ error: 'RESOURCE_EXHAUSTED quotaResetDelay:2h5m0s projects/secret-project-123/locations/us-central1' }] })
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', quota.brief], quota.io), EXIT.failed)
  const text = quota.out.join('\n')
  assert.match(text, /agy failed \(quota exhausted\).* The quota resets in about 2 h 5 min/)
  assert.doesNotMatch(text, /secret-project-123|us-central1/)
})

test('a stopped run ends cancelled', async () => {
  const h = await harness({ steps: [{ say: 'Partial.' }, { sleep: 10_000 }] })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 500)
  const code = await runTask(
    { ...h.io, cwd: h.project, signal: controller.signal },
    { mode: 'read-only', role: 'ask', briefFile: h.brief, minutes: 30, idleMinutes: 15, force: false, json: false },
  )
  assert.equal(code, EXIT.cancelled)
  assert.equal((await h.record()).status, 'cancelled')
})

test('follow resumes the session of the task it goes on from, one turn at a time', async () => {
  const h = await harness({ steps: [{ say: 'First.' }], retrySteps: [[{ say: 'Second.' }]] })
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.ok)
  const first = await h.record()
  await writeFile(h.brief, 'And the idle timer?')
  // A live process holds the session: the follow-up waits for it.
  const locks = join(h.state, 'spider-antigravity', 'locks')
  await mkdir(locks, { recursive: true })
  await writeFile(join(locks, `${first.sessionId}.lock`), JSON.stringify({ pid: process.pid, task: 'other' }))
  assert.equal(await cli(['follow', '--task', first.id, '--brief-file', h.brief], h.io), EXIT.failed)
  assert.match(h.out.join('\n'), /Task other is still running on this agy session/)
  await writeFile(join(locks, `${first.sessionId}.lock`), JSON.stringify({ pid: 999_999_999, task: 'gone' }))
  h.out.length = 0
  assert.equal(await cli(['follow', '--task', first.id, '--brief-file', h.brief], h.io), EXIT.ok)
  const entries = await h.entries()
  assert.ok(entries.some(entry => entry.resumed === first.sessionId))
  assert.match(prompts(entries).at(-1) ?? '', /^And the idle timer\?\n\nClient rules/)
  const second = await h.record()
  assert.equal(second.parent, first.id)
  assert.equal(second.sessionId, first.sessionId)
  assert.ok(!existsSync(join(locks, `${first.sessionId}.lock`)), 'the lock is released')
})

test('follow refuses an unknown task and run checks its flags', async () => {
  const h = await harness()
  assert.equal(await cli(['follow', '--task', '20260101-000000-abcdef', '--brief-file', h.brief], h.io), EXIT.usage)
  assert.match(h.err.join('\n'), /No task 20260101-000000-abcdef/)
  for (const argv of [
    ['run', '--brief-file', h.brief],
    ['run', '--role', 'ask'],
    ['run', '--role', 'ask', '--brief-file', h.brief, '--mode', 'yolo'],
    ['run', '--role', 'ask', '--brief-file', h.brief, '--minutes', '0'],
    ['follow', '--brief-file', h.brief],
    ['doctor', '--role', 'ask'],
  ]) assert.equal(await cli(argv, h.io), EXIT.usage, argv.join(' '))
  await writeFile(h.brief, '  \n')
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.usage)
  assert.match(h.err.at(-1) ?? '', /The brief is empty/)
})

async function repository(): Promise<string> {
  const repo = await realpath(await mkdtemp(join(tmpdir(), 'antigravity-repo-')))
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q', '-b', 'main')
  // Diff settings a person may have: the plugin's diffs and patches must not depend on them.
  for (const [key, value] of [['diff.noprefix', 'true'], ['color.ui', 'always'], ['diff.relative', 'true'], ['diff.external', 'false']]) git('config', key ?? '', value ?? '')
  await writeFile(join(repo, 'a.ts'), 'export const a = 1\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('switch', '-qc', 'feature')
  await writeFile(join(repo, 'a.ts'), 'export const a = 2\n')
  git('commit', '-qam', 'change')
  await writeFile(join(repo, 'loose.ts'), 'untracked\n')
  return repo
}

test('run review works in a throwaway worktree and returns checked findings', async () => {
  const repo = await repository()
  const answer = 'One issue.\n\n```json\n{"findings": [{"priority": "P2", "title": "a changed", "path": "a.ts", "line": 1, "detail": "It is 2 now."}, {"priority": "P0", "title": "breaks", "path": "a.ts", "line": 1, "detail": "Boom."}]}\n```'
  const h = await harness({ steps: [{ say: answer }] }, repo)
  assert.equal(await cli(['run', '--role', 'review', '--brief-file', h.brief], h.io), EXIT.ok)
  const text = h.out.join('\n')
  assert.match(text, /^Findings \(2\):\n\[P0\] breaks — a\.ts:1\n\[P2\] a changed — a\.ts:1$/m)
  assert.match(text, /^Note: 1 untracked file was not reviewed/m)
  const entries = await h.entries()
  const cwd = entries.find(entry => entry.start).start.cwd
  assert.notEqual(cwd, repo)
  assert.ok(!existsSync(cwd), 'the worktree is removed')
  assert.match(prompts(entries)[0] ?? '', /^Review the code changes of this git repository \(main\.\.\.HEAD\)[\s\S]*- a\.ts[\s\S]*The person asking adds:\nExplain the retry loop/)
  const task = await h.record()
  assert.equal(task.range, 'main...HEAD')
  assert.deepEqual(JSON.parse(await readFile(task.files.findings ?? '', 'utf8')).map((f: { priority: string }) => f.priority), ['P0', 'P2'])
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n').length, 1)
})

test('run review keeps the answer when the findings block does not fit', async () => {
  const repo = await repository()
  const h = await harness({ steps: [{ say: 'Looks fine to me.' }] }, repo)
  assert.equal(await cli(['run', '--role', 'review', '--brief-file', h.brief, '--commit', 'HEAD'], h.io), EXIT.ok)
  assert.match(h.out.join('\n'), /^Note: The answer has no ```json findings block\. The answer is saved as agy wrote it\.$/m)
  assert.match((await h.record()).range ?? '', /^[0-9a-f]{40}\^!$/)
})

test('run implement edits only its worktree and returns the change as a patch that applies', async () => {
  const repo = await repository()
  await writeFile(join(repo, 'a.ts'), 'export const a = 3\n')
  const h = await harness({ steps: [{ edit: { path: 'b.ts', content: 'export const b = 1\n' } }, { edit: { path: '../escape.txt', content: 'out\n' } }, { edit: { path: 'a.ts', content: 'export const a = 4\n' } }, { say: 'Added b.ts and set a to 4.' }] }, repo)
  assert.equal(await cli(['run', '--mode', 'implement', '--brief-file', h.brief], h.io), EXIT.ok)
  const text = h.out.join('\n')
  assert.match(text, /^Note: 1 uncommitted change in your checkout is not in agy's copy/m)
  assert.match(text, /^- edit: Edit \.\.\/escape\.txt \(an edit outside the worktree\)$/m)
  assert.match(text, /^Patch: \S+patch\.diff \(2 files, against [0-9a-f]{12}\)\n {2}M a\.ts\n {2}A b\.ts$/m)
  assert.match(text, /^Apply it: git -C \S+ apply --3way \S+patch\.diff$/m)
  const entries = await h.entries()
  const cwd = entries.find(entry => entry.start).start.cwd
  assert.ok(!existsSync(cwd), 'the worktree is removed')
  assert.ok(!existsSync(join(cwd, '..', 'escape.txt')))
  assert.match(prompts(entries)[0] ?? '', /delegates this change to you[\s\S]*you may read and edit files only inside /)
  // The checkout is untouched until the patch is applied.
  assert.equal(await readFile(join(repo, 'a.ts'), 'utf8'), 'export const a = 3\n')
  assert.ok(!existsSync(join(repo, 'b.ts')))
  const task = await h.record()
  execFileSync('git', ['-C', repo, 'checkout', '--', 'a.ts'])
  execFileSync('git', ['-C', repo, 'apply', '--3way', task.files.patch ?? ''])
  assert.equal(await readFile(join(repo, 'b.ts'), 'utf8'), 'export const b = 1\n')
  assert.equal(await readFile(join(repo, 'a.ts'), 'utf8'), 'export const a = 4\n')
})

test('follow of an implement task starts from its patch and returns both changes', async () => {
  const repo = await repository()
  const h = await harness({ steps: [{ edit: { path: 'b.ts', content: 'one\n' } }, { say: 'First.' }], resumeSteps: [{ edit: { path: 'c.ts', content: 'two\n' } }, { say: 'Second.' }] }, repo)
  assert.equal(await cli(['run', '--mode', 'implement', '--brief-file', h.brief], h.io), EXIT.ok)
  const first = await h.record()
  await writeFile(h.brief, 'Now add c.ts.')
  h.out.length = 0
  assert.equal(await cli(['follow', '--task', first.id, '--mode', 'implement', '--brief-file', h.brief], h.io), EXIT.ok)
  const second = await h.record()
  assert.equal(second.base, first.base)
  assert.deepEqual(second.changed, ['A\tb.ts', 'A\tc.ts'])
  assert.match(prompts(await h.entries()).at(-1) ?? '', /^Your earlier changes were applied in a fresh copy of the repository at /)
})

test('run implement refuses a review and needs a repository', async () => {
  const repo = await repository()
  const h = await harness({}, repo)
  assert.equal(await cli(['run', '--mode', 'implement', '--role', 'review', '--brief-file', h.brief], h.io), EXIT.usage)
  assert.match(h.err.join('\n'), /A review is read-only/)
  const plain = await harness()
  assert.equal(await cli(['run', '--mode', 'implement', '--brief-file', plain.brief], plain.io), EXIT.usage)
  assert.match(plain.out.join('\n'), /needs a git repository with at least one commit/)
})

test('a stopped implement task keeps the changes made so far', async () => {
  const repo = await repository()
  const h = await harness({ steps: [{ edit: { path: 'b.ts', content: 'partial\n' } }, { sleep: 10_000 }] }, repo)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 800)
  const code = await runTask({ ...h.io, cwd: repo, signal: controller.signal }, { mode: 'implement', role: 'analysis', briefFile: h.brief, minutes: 30, idleMinutes: 15, force: false, json: false })
  assert.equal(code, EXIT.cancelled)
  const task = await h.record()
  assert.deepEqual(task.changed, ['A\tb.ts'])
  assert.ok(task.notes.includes('The patch holds the changes made before the task ended.'))
  assert.equal(execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n').length, 1)
})

test('run review of one commit diffs a root commit against the empty tree', async () => {
  const repo = await repository()
  const root = execFileSync('git', ['-C', repo, 'rev-list', '--max-parents=0', 'HEAD']).toString().trim()
  const h = await harness({ steps: [{ say: 'ok\n\n```json\n{"findings": []}\n```' }] }, repo)
  assert.equal(await cli(['run', '--role', 'review', '--brief-file', h.brief, '--commit', root], h.io), EXIT.ok)
  assert.match(h.out.join('\n'), /^No findings\.$/m)
  assert.match(prompts(await h.entries())[0] ?? '', /changed files are:\n- a\.ts\n/)
})

test('follow refuses a parent task that is still running', async () => {
  const h = await harness({ steps: [{ say: 'First.' }] })
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.ok)
  const first = await h.record()
  await writeFile(first.files.record, JSON.stringify({ ...first, status: 'running', pid: process.pid }))
  assert.equal(await cli(['follow', '--task', first.id, '--brief-file', h.brief], h.io), EXIT.failed)
  assert.match(h.err.join('\n'), /is still running on this agy session/)
})

test('an implement follow-up that undoes every change leaves no patch', async () => {
  const repo = await repository()
  const h = await harness({ steps: [{ edit: { path: 'a.ts', content: 'export const a = 9\n' } }, { say: 'Set.' }], resumeSteps: [{ edit: { path: 'a.ts', content: 'export const a = 2\n' } }, { say: 'Undone.' }] }, repo)
  assert.equal(await cli(['run', '--mode', 'implement', '--brief-file', h.brief], h.io), EXIT.ok)
  const first = await h.record()
  assert.equal(await cli(['follow', '--task', first.id, '--mode', 'implement', '--brief-file', h.brief], h.io), EXIT.ok)
  const second = await h.record()
  assert.equal(second.files.patch, undefined)
  assert.equal(second.changed, undefined)
  assert.ok(second.notes.includes('agy changed no file.'))
  assert.equal(second.executedModel, first.executedModel)
})

test('run review keeps the findings that fit and counts the rest', async () => {
  const repo = await repository()
  const answer = 'Two.\n\n```JSON\n{"findings": [{"priority": "p1", "title": "string line", "path": "a.ts", "line": "1", "detail": "d"}, {"priority": "P9", "title": "bad", "path": "a.ts", "line": 1, "detail": "d"}]}\n```'
  const h = await harness({ steps: [{ say: answer }] }, repo)
  assert.equal(await cli(['run', '--role', 'review', '--brief-file', h.brief], h.io), EXIT.ok)
  const text = h.out.join('\n')
  assert.match(text, /^Findings \(1\):\n\[P1\] string line — a\.ts:1$/m)
  assert.match(text, /^Note: 1 finding does not fit the findings format and is only in the answer\.$/m)
})

test('an effort agy does not offer fails as effort unavailable, naming the levels', async () => {
  const h = await harness()
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief, '--effort', 'extreme'], h.io), EXIT.failed)
  assert.match(h.out.join('\n'), /^agy failed \(effort unavailable\): agy has no effort extreme \(agy offers low, medium, high\)\. Pass another --effort/m)
  assert.ok(!(await h.entries()).some(entry => entry.got?.method === 'session/set_config_option'))
})

test('the quota gate reuses a recent read', async () => {
  const h = await harness({ steps: [{ say: 'ok' }] })
  const cache = join(h.state, 'spider-antigravity', 'usage.json')
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.ok)
  const first = JSON.parse(await readFile(cache, 'utf8'))
  // A spent quota in the cache refuses the next task without asking agy again.
  await writeFile(cache, JSON.stringify({ at: first.at, buckets: first.buckets.map((bucket: { remaining: number }) => ({ ...bucket, remaining: 0.01 })) }))
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.failed)
  assert.match(h.err.join('\n'), /Not started: agy's quota is nearly spent/)
  await writeFile(cache, JSON.stringify({ at: first.at - 10 * 60_000, buckets: [] }))
  assert.equal(await cli(['run', '--role', 'ask', '--brief-file', h.brief], h.io), EXIT.ok)
})

test('a task stopped before agy starts ends cancelled without a session', async () => {
  const h = await harness()
  const controller = new AbortController()
  controller.abort()
  const code = await runTask({ ...h.io, cwd: h.project, signal: controller.signal }, { mode: 'read-only', role: 'ask', briefFile: h.brief, minutes: 30, idleMinutes: 15, force: false, json: false })
  assert.equal(code, EXIT.cancelled)
  assert.deepEqual(await h.entries(), [])
})
