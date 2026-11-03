import { expect, test } from 'claude-code/testing'
import { createRunner, launch, within, type RunnerDeps } from '../hooks/runner'
import type { Request } from '../hooks/model'
import { NOTICE } from '../hooks/presentation'
import { THREAD, answered, fakeOutput, fakeSpawn, file, line, type Script } from './fakes'
import { imagesDir } from '../hooks/output'

const ask: Request = { kind: 'ask', prompt: 'Review the plan', images: [], files: [] }

/** Lets the other pending tasks run first, as the time a real sleep takes would. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** A clock that moves only when the runner sleeps. */
function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => (await settle(), void (t += ms)) }
}

function deps(scripts: Script[], more: Partial<RunnerDeps> = {}) {
  const spawned = fakeSpawn(scripts)
  const out = fakeOutput()
  const time = clock()
  const toasts: string[] = []
  const submitted: string[] = []
  const waiting: (() => void)[] = []
  const d: RunnerDeps = {
    spawn: spawned.spawn,
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
  return { d, spawned, out, toasts, submitted, submission }
}

const limits = () => ({ foregroundMs: 60_000, backgroundMs: 600_000 })

test('within answers the value when it settles in time and undefined past the time, sleeping a minute at most', async () => {
  expect(await within(Promise.resolve(1), 1000, clock().sleep, clock().now)).toBe(1)
  const time = clock()
  const slept: number[] = []
  const sleep = async (ms: number) => (slept.push(ms), time.sleep(ms))
  expect(await within(new Promise(() => undefined), 150_000, sleep, time.now)).toBe(undefined)
  expect(slept.slice(-3)).toEqual([60_000, 60_000, 30_000])
})

test('launch reports a child that cannot start as a result, never a rejection', async () => {
  const running = launch(() => {
    throw new Error('spawn codex ENOENT')
  }, ['codex'], undefined)
  expect(await running.done).toEqual({ threadId: undefined, error: 'Codex could not run: spawn codex ENOENT' })
})

test('an ask runs codex in the session folder and answers in the foreground', async () => {
  const { d, spawned, out } = deps([{ stdout: answered('Looks fine.') }])
  const outcome = await createRunner(limits).runNow(d, ask)
  expect(spawned.runs).toEqual([{ argv: expect.arrayContaining(['/bin/codex', 'exec', '--', 'Review the plan']), cwd: undefined }])
  expect(outcome).toMatchObject({ ok: true, threadId: THREAD, markdown: 'Looks fine.' })
  expect(out.written).toHaveLength(1)
})

test('no codex executable answers why, and starts nothing', async () => {
  const { d, spawned } = deps([], { codex: async () => ({ error: 'not found' }) })
  expect(await createRunner(limits).runNow(d, ask)).toEqual({ ok: false, text: 'not found', error: 'not found' })
  expect(spawned.runs).toEqual([])
})

test('past the foreground wait the run goes on as a job, whose end sends a notice without the answer', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const { d, submitted, toasts, submission } = deps([{ stdout: answered('A secret answer.'), gate }])
  const runner = createRunner(limits)
  const outcome = await runner.runNow(d, ask)
  expect(outcome.ok).toBe(false)
  expect(outcome.text).toMatch(/^Codex is still working after 1 min: job #1 goes on in the background/)
  expect(runner.report(0)).toMatch(/^#1 ask running/)
  release()
  await submission()
  expect(toasts).toEqual(['Codex job #1 done'])
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(new RegExp(`^\\[codex notice: .*\\]\\njob #1 done: ask "Review the plan"\\nSaved to: /tmp/codex/.*\\.md\\nThread: ${THREAD}\\nRead the saved file for the answer\\.$`))
  expect(submitted[0]?.startsWith(NOTICE)).toBe(true)
  expect(submitted[0]).not.toMatch(/secret/)
  expect(runner.report(0)).toMatch(new RegExp(`^#1 ask done .*\\n  thread ${THREAD}; saved to /tmp/codex/`))
})

test('a job past the background limit is stopped and reported as timed out, with its thread', async () => {
  const gate = new Promise<void>(() => undefined)
  const { d, spawned, submitted, submission } = deps([{ stdout: line({ type: 'thread.started', thread_id: THREAD }), gate }])
  const runner = createRunner(() => ({ foregroundMs: 60_000, backgroundMs: 120_000 }))
  const job = await runner.startJob(d, ask)
  expect('id' in job && job.id).toBe(1)
  await submission()
  expect(spawned.stopped()).toBe(1)
  expect(submitted[0]).toMatch(/job #1 failed: ask/)
  expect(submitted[0]).toMatch(new RegExp(`Thread: ${THREAD}\\nTimed out: the run was stopped; resume the thread to go on\\.\\nNote: Codex did not finish within 2 min; the run was stopped\\.$`))
})

test('an image run starts in the plugin folder and hands back only the images a follow-up added', async () => {
  const dir = imagesDir('/h/.codex', THREAD)
  const { d, spawned, out } = deps([{ stdout: answered('A fox.'), onRun: () => out.dirs[dir]!.push(file('new.png', 2)) }])
  out.dirs[dir] = [file('old.png', 1)]
  const outcome = await createRunner(limits).runNow(d, { kind: 'image', prompt: 'Make it blue', threadId: THREAD, images: [], files: [] })
  expect(spawned.runs[0]?.cwd).toBe('/tmp/codex/.work')
  expect(out.ran[0]).toEqual(['mkdir', '-p', '/tmp/codex/.work'])
  expect(outcome.ok).toBe(true)
  expect(out.ran.filter(argv => argv[0] === 'cp').map(argv => argv[1])).toEqual([`${dir}/new.png`])
})
