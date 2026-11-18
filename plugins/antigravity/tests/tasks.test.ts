import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { lockSession } from '../cli/tasks.ts'

test('a stale session lock is taken over by one process only', async () => {
  const locks = await mkdtemp(join(tmpdir(), 'antigravity-locks-'))
  await writeFile(join(locks, 's1.lock'), JSON.stringify({ pid: 999_999_999, task: 'gone' }))
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => lockSession(locks, 's1', `t${index}`)))
  const won = results.filter(result => typeof result === 'function')
  assert.equal(won.length, 1)
  for (const result of results) if (typeof result !== 'function') assert.match(result.error, /still running|try again/)
  assert.equal(JSON.parse(await readFile(join(locks, 's1.lock'), 'utf8')).pid, process.pid)
  await (won[0] as () => Promise<void>)()
  assert.equal(typeof (await lockSession(locks, 's1', 'next')), 'function')
})
