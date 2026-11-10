import { expect, test } from 'claude-code/testing'
import { createRunner, type RunnerDeps } from '../hooks/runner'
import type { Job, Request } from '../hooks/model'
import { NOTICE } from '../hooks/presentation'
import { imagesDir } from '../hooks/output'
import { THREAD, answered, fakeOutput, file, line } from './fakes'
import { fakeRuns, memoryStore, type Run } from './runs'

const ask: Request = { kind: 'ask', prompt: 'Review the plan', images: [], files: [] }
const DAY = 24 * 60 * 60_000

/** Lets the other pending tasks run first, as the time a real sleep takes would. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** A clock that moves only when the runner sleeps. */
function clock(start = 0) {
  let t = start
  return { now: () => t, sleep: async (ms: number) => (await settle(), void (t += ms)), set: (ms: number) => void (t = ms) }
}

function deps(scripts: Run[], { session, memory: shared, ...more }: Partial<RunnerDeps> & { session?: string; memory?: ReturnType<typeof memoryStore> } = {}) {
  const runs = fakeRuns(scripts)
  const out = fakeOutput()
  const time = clock()
  const memory = shared ?? memoryStore()
  const toasts: string[] = []
  const submitted: string[] = []
  const waiting: (() => void)[] = []
  let ids = 0
  const d: RunnerDeps = {
    files: runs.files,
    store: memory.store,
    sessionId: async () => session ?? 'sess-a',
    project: async () => '/proj',
    newId: () => `j${++ids}`,
    runsDir: '/tmp/codex/runs',
    sleep: time.sleep,
    now: time.now,
    output: out.output,
    codex: async () => '/bin/codex',
    imageCwd: '/tmp/codex/.work',
    toast: text => void toasts.push(text),
    submit: async text => {
      submitted.push(text)
      for (const wake of waiting.splice(0)) wake()
    },
    ...more,
  }
  // Resolves once a background job has sent its notice.
  const submission = () => new Promise<void>(resolve => (submitted.length ? resolve() : waiting.push(resolve)))
  const job = async (id: string) => (await memory.store.get(`job:${id}`)) as Job | undefined
  return { d, runs, out, time, memory, toasts, submitted, submission, job }
}

const limits = () => ({ foregroundMs: 60_000, backgroundMs: 600_000 })
const started = line({ type: 'thread.started', thread_id: THREAD })

test('an ask runs codex detached in the session folder and answers in the foreground, leaving no job behind', async () => {
  const { d, runs, out, memory } = deps([{ stdout: answered('Looks fine.') }])
  const outcome = await createRunner(limits).runNow(d, ask)
  expect(runs.launched).toEqual([{ dir: '/tmp/codex/runs/j1', argv: expect.arrayContaining(['/bin/codex', 'exec', '--', 'Review the plan']), cwd: undefined }])
  expect(outcome).toMatchObject({ ok: true, threadId: THREAD, markdown: 'Looks fine.' })
  expect(out.written).toHaveLength(1)
  expect(runs.removed).toEqual(['/tmp/codex/runs/j1'])
  expect(await memory.store.keys()).toEqual([])
})

test('no codex executable answers why, and starts nothing', async () => {
  const { d, runs } = deps([], { codex: async () => ({ error: 'not found' }) })
  expect(await createRunner(limits).runNow(d, ask)).toEqual({ ok: false, text: 'not found', error: 'not found' })
  expect(runs.launched).toEqual([])
})

test('past the foreground wait the run goes on as a job, whose end sends a notice without the answer', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const { d, submitted, toasts, submission, job } = deps([{ stdout: answered('A secret answer.'), gate }])
  const runner = createRunner(limits)
  const outcome = await runner.runNow(d, ask)
  expect(outcome.ok).toBe(false)
  expect(outcome.text).toMatch(/^Codex is still working after 1 min: job #j1 goes on in the background/)
  expect(await job('j1')).toMatchObject({ status: 'running', background: true, threadId: THREAD, sessionId: 'sess-a' })
  expect(await runner.report(d)).toMatch(/^#j1 ask running/)
  release()
  await submission()
  expect(toasts).toEqual(['Codex job #j1 done'])
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(new RegExp(`^\\[codex notice: .*\\]\\njob #j1 done: ask "Review the plan"\\nSaved to: /tmp/codex/.*\\.md\\nThread: ${THREAD}\\nRead the saved file for the answer\\.$`))
  expect(submitted[0]?.startsWith(NOTICE)).toBe(true)
  expect(submitted[0]).not.toMatch(/secret/)
  expect(await job('j1')).toMatchObject({ status: 'done', notified: true })
  expect(await runner.report(d)).toMatch(new RegExp(`^#j1 ask done .*\\n  thread ${THREAD}; saved to /tmp/codex/`))
})

test('a job past the background limit is stopped once its process is checked, and reported as timed out', async () => {
  const { d, runs, submitted, submission } = deps([{ stdout: started, gate: new Promise(() => undefined) }])
  const runner = createRunner(() => ({ foregroundMs: 60_000, backgroundMs: 120_000 }))
  const job = await runner.startJob(d, ask)
  expect('id' in job && job.id).toBe('j1')
  await submission()
  expect(runs.stopped).toEqual(['/tmp/codex/runs/j1'])
  expect(submitted[0]).toMatch(/job #j1 failed: ask/)
  expect(submitted[0]).toMatch(new RegExp(`Thread: ${THREAD}\\nTimed out: the run was stopped; resume the thread to go on\\.\\nNote: Codex did not finish within 2 min; the run was stopped\\.$`))
})

test('a background limit below the foreground wait bounds the whole run', async () => {
  const { d, runs, submitted, submission, time } = deps([{ stdout: started, gate: new Promise(() => undefined) }])
  const runner = createRunner(() => ({ foregroundMs: 600_000, backgroundMs: 120_000 }))
  const outcome = await runner.runNow(d, ask)
  expect(outcome.text).toMatch(/^Codex is still working after 2 min/)
  await submission()
  expect(runs.stopped).toHaveLength(1)
  expect(time.now()).toBeLessThanOrEqual(122_000)
  expect(submitted[0]).toMatch(/Note: Codex did not finish within 2 min; the run was stopped\.$/)
})

test('a run whose process vanished without an answer is recovered from Codex’s own files, else lost', async () => {
  const gate = new Promise(() => undefined)
  const { d, runs, submitted, submission, job } = deps([
    { stdout: started, gate },
    { stdout: line({ type: 'thread.started', thread_id: 'other' }), gate },
  ])
  runs.rollouts[THREAD] = { since: 0, answer: 'Recovered answer.' }
  // An answer from before this run (an earlier turn of a followed-up thread) is not this run's.
  runs.rollouts.other = { since: -1, answer: 'An earlier turn.' }
  const runner = createRunner(limits)
  await runner.startJob(d, ask)
  runs.dead.add('/tmp/codex/runs/j1')
  await submission()
  expect(await job('j1')).toMatchObject({ status: 'done', threadId: THREAD })
  expect(submitted[0]).toMatch(/job #j1 done: ask/)

  await runner.startJob(d, ask)
  runs.dead.add('/tmp/codex/runs/j2')
  await new Promise<void>(resolve => {
    const wait = () => (submitted.length > 1 ? resolve() : void settle().then(wait))
    wait()
  })
  expect(await job('j2')).toMatchObject({ status: 'lost', threadId: 'other' })
  expect(submitted[1]).toMatch(/job #j2 lost: ask/)
  expect(submitted[1]).toMatch(/Note: Codex stopped before an answer that could be recovered; ask on the thread to go on\.$/)
  expect(runs.stopped).toEqual([])
})

test('after a reload the session picks its running jobs up again and sends their end notice', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const first = deps([{ stdout: answered('Done.'), gate }])
  await createRunner(limits).startJob(first.d, ask)
  // The module starts over; the store and the detached run do not.
  const again = createRunner(limits)
  const second = { ...first.d }
  await again.resume(second)
  release()
  await first.submission()
  expect(first.submitted).toHaveLength(1)
  expect(first.submitted[0]).toMatch(/job #j1 done: ask/)
})

test('a run whose foreground wait a reload cut short is picked up as a job', async () => {
  const { d, memory, submitted, submission, job } = deps([{ stdout: answered('Done.') }])
  const runner = createRunner(limits)
  const record: Job = { id: 'j9', kind: 'ask', prompt: 'p', status: 'running', startedAt: 0, sessionId: 'sess-a', project: '/proj', seenAt: 0, dir: '/tmp/codex/runs/j9', background: false, request: ask, before: [] }
  await d.files.launch(record.dir, ['/bin/codex', 'exec'], undefined)
  await memory.store.set('job:j9', record)
  await runner.resume(d)
  await submission()
  expect(await job('j9')).toMatchObject({ status: 'done', background: true, notified: true })
  expect(submitted[0]).toMatch(/job #j9 done/)
})

test('another session’s job no watcher has seen for a minute is taken over, finished and notified once', async () => {
  const shared = memoryStore()
  const owner = deps([{ stdout: answered('Done.') }], { session: 'sess-a', memory: shared })
  const record: Job = { id: 'j5', kind: 'ask', prompt: 'p', status: 'running', startedAt: 0, sessionId: 'sess-a', project: '/proj', seenAt: 0, dir: '/tmp/codex/runs/j5', background: true, request: ask, before: [] }
  await owner.d.files.launch(record.dir, ['/bin/codex', 'exec'], undefined)
  await settle()
  await shared.store.set('job:j5', record)
  const next = deps([], { session: 'sess-b', memory: shared })
  next.time.set(30_000)
  // Seen half a minute ago, the job is left to its watcher; the look a minute later is the next test's.
  await createRunner(limits).resume({ ...next.d, files: owner.d.files, sleep: () => new Promise(() => undefined) })
  await settle()
  expect(next.submitted).toEqual([])
  next.time.set(120_000)
  await createRunner(limits).resume({ ...next.d, files: owner.d.files })
  await next.submission()
  expect(next.submitted).toHaveLength(1)
  expect(next.submitted[0]).toMatch(/job #j5 done/)
  await createRunner(limits).resume({ ...next.d, files: owner.d.files })
  expect(next.submitted).toHaveLength(1)
})

test('another session’s watched job is left to it; once unwatched past the limit it is stopped by the session that takes it over', async () => {
  const shared = memoryStore()
  const owner = deps([{ stdout: started, gate: new Promise(() => undefined) }], { session: 'sess-a', memory: shared })
  await createRunner(limits).startJob(owner.d, ask)
  const next = deps([], { session: 'sess-b', memory: shared })
  const d = { ...next.d, files: owner.d.files }
  await createRunner(limits).resume(d)
  expect(owner.runs.stopped).toEqual([])
  next.time.set(700_000)
  await createRunner(limits).resume(d)
  await next.submission()
  expect(owner.runs.stopped).toEqual(['/tmp/codex/runs/j1'])
  expect(next.submitted[0]).toMatch(/job #j1 failed: ask/)
})

test('a taken-over job past its limit whose process is gone is read as it ended, not reported as stopped', async () => {
  const shared = memoryStore()
  const owner = deps([{ stdout: started, gate: new Promise(() => undefined) }], { session: 'sess-a', memory: shared })
  await createRunner(limits).startJob(owner.d, ask)
  owner.runs.dead.add('/tmp/codex/runs/j1')
  const next = deps([], { session: 'sess-b', memory: shared })
  next.time.set(700_000)
  await createRunner(limits).resume({ ...next.d, files: owner.d.files })
  await next.submission()
  expect(owner.runs.stopped).toEqual([])
  expect(next.submitted[0]).toMatch(/job #j1 lost: ask/)
  expect(next.submitted[0]).not.toMatch(/the run was stopped/)
})

test('a job another session watched a moment ago is looked at again a minute later, and taken over when that session is gone', async () => {
  const shared = memoryStore()
  // The other session went away right after starting its job: its watch never beats again.
  const owner = deps([{ stdout: started, gate: new Promise(() => undefined) }], { session: 'sess-a', memory: shared, sleep: () => new Promise(() => undefined) })
  await createRunner(limits).startJob(owner.d, ask)
  owner.runs.dead.add('/tmp/codex/runs/j1')
  const next = deps([], { session: 'sess-b', memory: shared })
  await createRunner(limits).resume({ ...next.d, files: owner.d.files })
  await next.submission()
  expect(next.submitted[0]).toMatch(/job #j1 lost: ask/)
  expect(next.time.now()).toBeGreaterThanOrEqual(62_000)
})

test('another project’s job is left alone until it is unwatched past its limit, then stopped without a notice', async () => {
  const shared = memoryStore()
  const owner = deps([{ stdout: started, gate: new Promise(() => undefined) }], { session: 'sess-a', memory: shared, project: async () => '/other' })
  await createRunner(limits).startJob(owner.d, ask)
  const next = deps([], { session: 'sess-b', memory: shared })
  const d = { ...next.d, files: owner.d.files }
  next.time.set(120_000)
  await createRunner(limits).resume(d)
  expect(owner.runs.stopped).toEqual([])
  next.time.set(700_000)
  await createRunner(limits).resume(d)
  while ((await next.job('j1'))?.status === 'running') await settle()
  expect(owner.runs.stopped).toEqual(['/tmp/codex/runs/j1'])
  expect(await next.job('j1')).toMatchObject({ status: 'failed', project: '/other' })
  expect(next.submitted).toEqual([])
})

test('finished jobs are pruned past 7 days or past the 50 newest, with their run folders', async () => {
  const records: Record<string, Job> = {}
  for (let i = 0; i < 52; i++) {
    records[`job:k${i}`] = { id: `k${i}`, kind: 'ask', prompt: 'p', status: 'done', startedAt: i, endedAt: 8 * DAY + i, sessionId: 's', project: '/proj', seenAt: 0, dir: `/r/k${i}`, background: true, notified: true, request: ask, before: [] }
  }
  records['job:old'] = { ...records['job:k0']!, id: 'old', endedAt: 0, dir: '/r/old' }
  const memory = memoryStore(records)
  const { d, runs } = deps([], { memory })
  ;(d as { now: () => number }).now = () => 8 * DAY + 100
  await createRunner(limits).resume(d)
  const left = (await memory.store.keys()).sort()
  expect(left).toHaveLength(50)
  expect(left).not.toContain('job:old')
  expect(left).not.toContain('job:k0')
  expect(left).not.toContain('job:k1')
  expect(runs.removed.sort()).toEqual(['/r/k0', '/r/k1', '/r/old'])
})

test('an image run starts in the plugin folder and hands back only the images a follow-up added', async () => {
  const dir = imagesDir('/h/.codex', THREAD)
  const { d, runs, out } = deps([{ stdout: answered('A fox.'), onEnd: () => out.dirs[dir]!.push(file('new.png', 2)) }])
  out.dirs[dir] = [file('old.png', 1)]
  const outcome = await createRunner(limits).runNow(d, { kind: 'image', prompt: 'Make it blue', threadId: THREAD, images: [], files: [] })
  expect(runs.launched[0]?.cwd).toBe('/tmp/codex/.work')
  expect(out.ran[0]).toEqual(['mkdir', '-p', '/tmp/codex/.work'])
  expect(outcome.ok).toBe(true)
  expect(out.ran.filter(argv => argv[0] === 'cp').map(argv => argv[1])).toEqual([`${dir}/new.png`])
})

test('a foreground wait that fails leaves the run going as a job for the next session start', async () => {
  const { d, runs, job } = deps([{ stdout: started, gate: new Promise(() => undefined) }], {
    sleep: async () => {
      throw new Error('sleep: not found')
    },
  })
  const outcome = await createRunner(limits).runNow(d, ask)
  expect(outcome).toMatchObject({ ok: false, threadId: THREAD })
  expect(outcome.text).toMatch(/^The wait for Codex failed \(sleep: not found\)\. Codex is still working after 1 min: job #j1 goes on/)
  await settle()
  expect(runs.stopped).toEqual([])
  expect(await job('j1')).toMatchObject({ status: 'running', background: true })
})

test('a job has one watcher: the one a reload left behind lets go, and one notice goes out', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const { d, submitted, submission } = deps([{ stdout: answered('Done.'), gate }])
  await createRunner(limits).startJob(d, ask)
  await settle()
  // The old module's watch keeps polling; the new module's resume takes the job over.
  await createRunner(limits).resume(d)
  release()
  await submission()
  for (let i = 0; i < 20; i++) await d.sleep(2_000)
  expect(submitted).toHaveLength(1)
})

test('the jobs list keeps why a job failed', async () => {
  const { d, submission } = deps([{ stdout: line({ type: 'turn.failed', error: { message: 'Not logged in' } }), exit: 1 }])
  const runner = createRunner(limits)
  await runner.startJob(d, ask)
  await submission()
  expect(await runner.report(d)).toMatch(/^#j1 ask failed .*\n  error: Not logged in$/)
})
