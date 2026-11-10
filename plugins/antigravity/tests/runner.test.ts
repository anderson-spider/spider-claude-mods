import { expect, test } from 'claude-code/testing'
import type { Job, Request } from '../hooks/model'
import { NOTICE } from '../hooks/presentation'
import { createRunner, type RunnerDeps } from '../hooks/runner'
import { CONVERSATION, answered, imaged, init } from './fakes'
import { fakeRuns, fakeWorkspaces, memoryStore, type Run } from './runs'

const ask: Request = { kind: 'ask', prompt: 'Review the plan', files: [] }
const review: Request = { kind: 'review', prompt: 'review against main', files: [], review: { base: 'main' } }
const image: Request = { kind: 'image', prompt: 'A rocket', files: [] }
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

function gated() {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  return { gate, release }
}

function deps(scripts: Run[], { session, memory: shared, left, ...more }: Partial<RunnerDeps> & { session?: string; memory?: ReturnType<typeof memoryStore>; left?: string[] } = {}) {
  const runs = fakeRuns(scripts)
  const spaces = fakeWorkspaces({ left })
  const time = clock()
  const memory = shared ?? memoryStore()
  const written: { path: string; text: string }[] = []
  // agy's artifacts folders by path, and the commands the output ran (cp, sips, mkdir).
  const listings: Record<string, { name: string; kind: 'file' | 'dir'; mtimeMs: number }[]> = {}
  const ran: string[][] = []
  const toasts: string[] = []
  const submitted: string[] = []
  const waiting: (() => void)[] = []
  let ids = 0
  const d: RunnerDeps = {
    files: runs.files,
    store: memory.store,
    workspaces: spaces.workspaces,
    sessionId: async () => session ?? 'sess-a',
    project: async () => '/proj',
    newId: () => `j${++ids}`,
    runsDir: '/tmp/agy/runs',
    sleep: time.sleep,
    now: time.now,
    output: {
      write: async (path, text) => void written.push({ path, text }),
      outDir: '/tmp/agy',
      artifactsRoot: '/h/.gemini/antigravity-cli/brain',
      list: async path => listings[path] ?? [],
      run: async argv => (ran.push(argv), { exitCode: argv[0] === 'sips' ? 1 : 0, stdout: '', stderr: '' }),
      readBytes: async () => ({ base64: '' }),
    },
    agy: async () => '/bin/agy',
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
  return { d, runs, spaces, time, memory, written, listings, ran, toasts, submitted, submission, job }
}

const limits = () => ({ foregroundMs: 60_000, backgroundMs: 600_000 })

test('an ask that ends in the foreground answers and leaves no job behind', async () => {
  const { d, runs, written, memory } = deps([{ stdout: answered('Looks fine.') }])

  const outcome = await createRunner(limits).runNow(d, ask)

  expect(runs.launched).toEqual([{ dir: '/tmp/agy/runs/j1', argv: expect.arrayContaining(['/bin/agy', '--print-timeout=570s']), cwd: '/proj' }])
  expect(outcome).toMatchObject({ ok: true, conversationId: CONVERSATION, markdown: 'Looks fine.' })
  expect(written).toHaveLength(1)
  expect(runs.removed).toEqual(['/tmp/agy/runs/j1'])
  expect(await memory.store.keys()).toEqual([])
})

test('past the foreground wait a review goes on as a job, whose end sends a notice without the answer and removes its worktree', async () => {
  const { gate, release } = gated()
  const { d, runs, spaces, submitted, toasts, submission, job } = deps([{ stdout: answered('[P0] A secret finding — a.ts:1'), gate }])
  const runner = createRunner(limits)

  const moved = await runner.runNow(d, review)

  expect(moved).toEqual({ ok: false, text: 'agy is still working after 1 min: job #j1 goes on in the background and a message arrives when it ends (the jobs tool shows it meanwhile).', conversationId: CONVERSATION })
  expect(runs.launched[0]!.cwd).toBe('/tmp/agy/worktrees/j1')
  expect(await job('j1')).toMatchObject({ status: 'running', background: true, conversationId: CONVERSATION })
  expect(await runner.report(d)).toMatch(/^#j1 review running \(for 1 min\): review against main\n  conversation /)
  expect(spaces.removed).toEqual([])

  release()
  await submission()

  expect(toasts).toEqual(['agy job #j1 done'])
  expect(submitted[0]).toMatch(new RegExp(`^${NOTICE.replace(/[[\]]/g, '\\$&')}\\njob #j1 done: review "review against main"\\nSaved to: /tmp/agy/.*\\nConversation: ${CONVERSATION}\\nRead the saved file for the review\\.$`))
  expect(submitted[0]).not.toMatch(/secret/)
  expect(spaces.removed).toEqual([{ project: '/proj', worktree: '/tmp/agy/worktrees/j1' }])
  expect(await job('j1')).toMatchObject({ status: 'done', notified: true })
})

test('a job past the background limit is stopped once its process is checked, and reported as timed out', async () => {
  const { gate } = gated()
  const { d, runs, submitted, submission, job } = deps([{ stdout: init(), gate }])

  await createRunner(limits).startJob(d, ask)
  await submission()

  expect(runs.stopped).toEqual(['/tmp/agy/runs/j1'])
  expect(await job('j1')).toMatchObject({ status: 'failed', error: 'agy failed (timed out): it did not finish within 10 min, and the run was stopped.' })
  expect(submitted[0]).toMatch(/Timed out: the run was stopped; continue the conversation to go on\./)
})

test('a run whose process vanished without an exit status is lost, and never run again', async () => {
  const { gate } = gated()
  const { d, runs, submitted, submission, job } = deps([{ stdout: init(), gate }])
  runs.dead.add('/tmp/agy/runs/j1')

  await createRunner(limits).startJob(d, ask)
  await submission()

  expect(await job('j1')).toMatchObject({ status: 'lost', conversationId: CONVERSATION })
  expect(submitted[0]).toMatch(/^.*\njob #j1 lost: ask "Review the plan"\nConversation: .*\nNote: agy stopped before an answer the plugin could read \(lost\); it is never re-run/)
  expect(runs.launched).toHaveLength(1)
})

test('a follow-up on a conversation that is still running is refused, naming its job', async () => {
  const { gate, release } = gated()
  const { d, runs, submission } = deps([{ stdout: answered('Slow.'), gate }])
  const runner = createRunner(limits)
  await runner.startJob(d, { ...ask, conversationId: CONVERSATION })

  const refused = await runner.runNow(d, { ...ask, conversationId: CONVERSATION })

  expect(refused).toMatchObject({ ok: false, error: `Conversation ${CONVERSATION} is still running as job #j1; ask on it again once that ends (the jobs tool shows it).` })
  expect(runs.launched).toHaveLength(1)
  release()
  await submission()
})

test('after a reload the session picks its running job up again, with one watcher and one notice', async () => {
  const { gate, release } = gated()
  const memory = memoryStore()
  const first = deps([{ stdout: answered('Done.'), gate }], { memory })
  const runner = createRunner(limits)
  await runner.startJob(first.d, ask)

  // The reload: a new module's runner on the same store resumes the job; the old watcher lets go of it.
  const again = deps([], { memory })
  again.runs.states.set('/tmp/agy/runs/j1', first.runs.states.get('/tmp/agy/runs/j1')!)
  await createRunner(limits).resume(again.d)
  release()
  await again.submission()
  for (let i = 0; i < 20; i++) await first.time.sleep(2_000)

  expect(again.submitted).toHaveLength(1)
  expect(first.submitted).toEqual([])
})

test('another session’s job no watcher has seen for a minute is taken over and notified here; a fresh one is left alone', async () => {
  const memory = memoryStore()
  const other = deps([{ stdout: answered('Theirs.'), gate: new Promise(() => undefined) }], { memory, session: 'sess-0' })
  await createRunner(limits).startJob(other.d, ask)
  const mine = deps([], { memory, session: 'sess-b' })
  mine.runs.states.set('/tmp/agy/runs/j1', { head: answered('Theirs.').split('\n')[0]!, tail: answered('Theirs.'), exit: 0, endedAt: 30_000 })

  // Seen a moment ago, the job is left to its watcher; the look a minute later is the next test's.
  await createRunner(limits).resume({ ...mine.d, sleep: () => new Promise(() => undefined) })
  await settle()
  expect(mine.submitted).toEqual([])

  mine.time.set(120_000)
  await createRunner(limits).resume(mine.d)
  await mine.submission()
  expect(mine.submitted[0]).toMatch(/job #j1 done: ask "Review the plan"/)
  // It ended while nobody watched: the time its exit file says, not the time it was found.
  expect(((await mine.memory.store.get('job:j1')) as Job).endedAt).toBe(30_000)
})

test('a job another session watched a moment ago is looked at again a minute later, and taken over when that session is gone', async () => {
  const memory = memoryStore()
  // The other session went away right after starting its job: its watch never beats again.
  const other = deps([{ stdout: answered('Theirs.'), gate: new Promise(() => undefined) }], { memory, session: 'sess-0', sleep: () => new Promise(() => undefined) })
  await createRunner(limits).startJob(other.d, ask)
  const mine = deps([], { memory, session: 'sess-b' })
  mine.runs.states.set('/tmp/agy/runs/j1', { head: answered('Theirs.').split('\n')[0]!, tail: answered('Theirs.'), exit: 0, endedAt: 30_000 })

  await createRunner(limits).resume(mine.d)
  await mine.submission()

  expect(mine.submitted[0]).toMatch(/job #j1 done: ask "Review the plan"/)
  expect(mine.time.now()).toBeGreaterThanOrEqual(62_000)
})

test('a taken-over job past its limit whose process is gone is read as it ended, not reported as stopped', async () => {
  const memory = memoryStore()
  const other = deps([{ stdout: init(), gate: new Promise(() => undefined) }], { memory, session: 'sess-0', sleep: () => new Promise(() => undefined) })
  await createRunner(limits).startJob(other.d, ask)
  other.runs.dead.add('/tmp/agy/runs/j1')
  const mine = deps([], { memory, session: 'sess-b' })
  mine.time.set(700_000)

  await createRunner(limits).resume({ ...mine.d, files: other.d.files })
  await mine.submission()

  expect(other.runs.stopped).toEqual([])
  expect(mine.submitted[0]).toMatch(/job #j1 lost: ask/)
  expect(mine.submitted[0]).not.toMatch(/the run was stopped/)
})

test('another project’s job is left alone until it is unwatched past its limit, then stopped without a notice', async () => {
  const memory = memoryStore()
  const other = deps([{ stdout: init(), gate: new Promise(() => undefined) }], { memory, session: 'sess-0', project: async () => '/other', sleep: () => new Promise(() => undefined) })
  await createRunner(limits).startJob(other.d, ask)
  const mine = deps([], { memory, session: 'sess-b' })
  const d = { ...mine.d, files: other.d.files }

  mine.time.set(120_000)
  await createRunner(limits).resume(d)
  expect(other.runs.stopped).toEqual([])

  mine.time.set(700_000)
  await createRunner(limits).resume(d)
  while ((await mine.job('j1'))?.status === 'running') await settle()
  expect(other.runs.stopped).toEqual(['/tmp/agy/runs/j1'])
  expect(await mine.job('j1')).toMatchObject({ status: 'failed', project: '/other' })
  expect(mine.submitted).toEqual([])
})

test('session start prunes finished jobs past 7 days or the 50 newest, and removes worktrees no running job holds', async () => {
  const memory = memoryStore()
  const record = (id: string, endedAt: number) => ({ id, kind: 'ask', prompt: id, status: 'done', startedAt: endedAt, endedAt, sessionId: 's', project: '/proj', seenAt: 0, dir: `/tmp/agy/runs/${id}`, background: true, request: ask, workspace: { cwd: '/proj' } })
  for (let i = 0; i < 52; i++) await memory.store.set(`job:k${i}`, record(`k${i}`, 8 * DAY + i))
  await memory.store.set('job:old', record('old', 0))
  await memory.store.set('job:live', { ...record('live', 8 * DAY), status: 'running', endedAt: undefined, sessionId: 'other', seenAt: 8 * DAY + 100 })
  const { d, runs, spaces } = deps([], { memory, left: ['live', 'old', 'stray'] })
  d.now = () => 8 * DAY + 100

  await createRunner(limits).resume(d)

  const kept = (await memory.store.keys()).sort()
  expect(kept).toHaveLength(50)
  expect(kept).toContain('job:live')
  expect(kept).not.toContain('job:old')
  expect(kept).not.toContain('job:k0')
  expect(runs.removed).toEqual(expect.arrayContaining(['/tmp/agy/runs/old', '/tmp/agy/runs/k0', '/tmp/agy/runs/k1']))
  expect(spaces.removed.map(r => r.worktree).sort()).toEqual(['/tmp/agy/worktrees/old', '/tmp/agy/worktrees/stray'])
})

test('two follow-ups started at once on one conversation: one runs, the other is refused', async () => {
  const { gate, release } = gated()
  const { d, runs, submission } = deps([{ stdout: answered('Slow.'), gate }])
  const runner = createRunner(limits)

  const [a, b] = await Promise.all([runner.startJob(d, { ...ask, conversationId: CONVERSATION }), runner.startJob(d, { ...ask, conversationId: CONVERSATION })])

  expect([a, b].filter(job => 'dir' in job)).toHaveLength(1)
  expect([a, b].find(job => !('dir' in job))).toMatchObject({ ok: false, error: expect.stringMatching(/^Conversation .* is still running/) })
  expect(runs.launched).toHaveLength(1)
  release()
  await submission()
})

test('a review worktree being made is already held by its job, so a session start meanwhile leaves it alone', async () => {
  const { gate, release } = gated()
  const memory = memoryStore()
  const starting = deps([{ stdout: answered('Fine.') }], { memory })
  const sweeper = deps([], { memory, session: 'sess-b' })
  const made = starting.spaces.workspaces.review
  starting.spaces.workspaces.review = async (project, id, target) => {
    const workspace = await made(project, id, target)
    sweeper.spaces.left.add(id)
    await gate
    return workspace
  }

  const run = createRunner(limits).runNow(starting.d, review)
  await settle()
  await createRunner(limits).resume(sweeper.d)
  release()
  await run

  expect(sweeper.spaces.removed).toEqual([])
})

test('a foreground wait that fails says how long agy really ran, not the configured wait', async () => {
  const { gate, release } = gated()
  const { d } = deps([{ stdout: answered('Late.'), gate }], {
    sleep: async () => {
      throw new Error('aborted')
    },
  })

  const moved = await createRunner(limits).runNow(d, ask)

  expect(moved.text).toBe(
    'The wait for agy failed (aborted). agy is still working after less than a minute: job #j1 goes on in the background and a message arrives when it ends (the jobs tool shows it meanwhile).',
  )
  release()
})

test('past the foreground wait an image goes on as a job, whose end copies the image its run added, names it in the notice and removes the work folder', async () => {
  const { gate, release } = gated()
  const { d, runs, spaces, listings, ran, submitted, submission } = deps([{ stdout: imaged('Done.'), gate }])

  const moved = await createRunner(limits).runNow(d, image)

  expect(moved).toMatchObject({ ok: false, text: expect.stringMatching(/^agy is still working after 1 min: job #j1 goes on/) })
  expect(runs.launched[0]!.cwd).toBe('/tmp/agy/.work/j1')
  listings[`/h/.gemini/antigravity-cli/brain/${CONVERSATION}`] = [{ name: 'rocket_1.png', kind: 'file', mtimeMs: 1 }]
  release()
  await submission()

  expect(ran).toContainEqual(['cp', `/h/.gemini/antigravity-cli/brain/${CONVERSATION}/rocket_1.png`, expect.stringMatching(/^\/tmp\/agy\/\d{8}-\d{6}-a-rocket\.png$/)])
  expect(submitted[0]).toMatch(
    new RegExp(`^${NOTICE.replace(/[[\]]/g, '\\$&')}\\njob #j1 done: image "A rocket"\\nSaved to: /tmp/agy/\\d{8}-\\d{6}-a-rocket\\.png\\nConversation: ${CONVERSATION}\\nLook at the file before describing it`),
  )
  expect(spaces.discarded).toEqual(['/tmp/agy/.work/j1'])
})

test('a follow-up image on a conversation that is still running is refused, naming its job', async () => {
  const { gate, release } = gated()
  const { d, runs } = deps([{ stdout: imaged('Done.'), gate }])
  const runner = createRunner(limits)

  await runner.startJob(d, { ...image, conversationId: CONVERSATION })
  const busy = await runner.runNow(d, { ...image, prompt: 'Make it blue', conversationId: CONVERSATION })

  expect(busy).toMatchObject({ ok: false, text: `Conversation ${CONVERSATION} is still running as job #j1; ask on it again once that ends (the jobs tool shows it).` })
  expect(runs.launched).toHaveLength(1)
  release()
})
