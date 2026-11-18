import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runProcess } from '../cli/process.ts'

test('runProcess returns the exit code and both streams', async () => {
  const run = await runProcess(['sh', '-c', 'echo out; echo err >&2; exit 3'], { timeoutMs: 5_000 })
  assert.deepEqual({ code: run.code, stdout: run.stdout, stderr: run.stderr, timedOut: run.timedOut }, { code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
})

test('runProcess gives the child no stdin, so a reader gets end of file at once', async () => {
  const run = await runProcess(['sh', '-c', 'cat; echo done'], { timeoutMs: 5_000 })
  assert.equal(run.stdout, 'done\n')
})

test('runProcess kills a group that ignores SIGTERM, children included', async () => {
  const started = Date.now()
  const run = await runProcess(['sh', '-c', 'trap "" TERM; sleep 30 & wait'], { timeoutMs: 200, killGraceMs: 200 })
  assert.equal(run.timedOut, true)
  assert.equal(run.signal, 'SIGKILL')
  assert.ok(Date.now() - started < 5_000)
})

test('runProcess reports an executable that cannot start', async () => {
  const run = await runProcess(['/nonexistent/agy'], { timeoutMs: 1_000 })
  assert.match(run.spawnError ?? '', /ENOENT/)
})
