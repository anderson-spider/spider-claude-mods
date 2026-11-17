// The job files on a real disk, through the MCP server's Node host: what one side saves, the other reads.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

// As server/main.mjs does: hooks/ imports each other without an extension.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})
const { fileStore } = await import('../../hooks/jobs.ts')
const { run } = await import('../../server/host.mjs')
const { replyOf, optionsFrom } = await import('../../server/serve.mjs')

/** @type {string} */
let tmp
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'agy-jobs-'))
})
after(() => rm(tmp, { recursive: true, force: true }))

/** @param {string} root */
const storeIn = (root) =>
  fileStore(
    {
      run,
      read: (path) => import('node:fs/promises').then(({ readFile }) => readFile(path, 'utf8')).catch(() => undefined),
      list: (path) => readdir(path),
    },
    root,
    `${root}/jobs`,
  )

test('a saved job reads back whole, lists by its key, is private to the user, and is gone once deleted', async () => {
  const root = join(tmp, 'agy')
  const store = storeIn(root)
  const job = { id: 'a1', status: 'running', prompt: 'Hi “there”' }

  await store.set('job:a1', job)

  assert.deepEqual(await store.get('job:a1'), job)
  assert.deepEqual(await store.keys(), ['job:a1'])
  assert.equal((await stat(root)).mode & 0o777, 0o700)
  assert.equal((await stat(join(root, 'jobs', 'job%3Aa1.json'))).mode & 0o077, 0)
  await store.delete('job:a1')
  assert.deepEqual(await store.keys(), [])
  assert.equal(await store.get('job:a1'), undefined)
})

test('a file that does not parse reads as missing, and a half-written one never shows among the keys', async () => {
  const root = join(tmp, 'other')
  const store = storeIn(root)
  await store.set('job:b1', { id: 'b1' })
  await writeFile(join(root, 'jobs', 'job%3Ab1.json'), '{')
  await writeFile(join(root, 'jobs', 'job%3Ac1.json.123'), '{')

  assert.equal(await store.get('job:b1'), undefined)
  assert.deepEqual(await store.keys(), ['job:b1'])
})

test('a plugin folder that is a link is refused, and nothing is saved', async () => {
  const { symlink } = await import('node:fs/promises')
  const target = join(tmp, 'target')
  const link = join(tmp, 'link')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(target))
  await symlink(target, link)

  await assert.rejects(storeIn(link).set('job:x', {}))
  assert.deepEqual(await readdir(target), [])
})

test('an image answer becomes MCP image content after its text; an error keeps isError', () => {
  const source = { type: /** @type {const} */ ('base64'), media_type: 'image/png', data: 'UE5H' }
  assert.deepEqual(replyOf({ result: [{ type: 'text', text: 'Saved.' }, { type: 'image', source }] }), {
    content: [
      { type: 'text', text: 'Saved.' },
      { type: 'image', data: 'UE5H', mimeType: 'image/png' },
    ],
  })
  assert.deepEqual(replyOf({ result: 'No.', isError: true }), { content: [{ type: 'text', text: 'No.' }], isError: true })
})

test('the options are read from the environment and taken out of it, an empty or unexpanded one left unset', () => {
  /** @type {Record<string, string | undefined>} */
  const env = { SPIDER_ANTIGRAVITY_OPTION_DEFAULT_MODEL: 'gemini-x', SPIDER_ANTIGRAVITY_OPTION_AGY_PATH: '', SPIDER_ANTIGRAVITY_OPTION_FOREGROUND_MINUTES: '${user_config.foregroundMinutes}', KEEP: '1' }
  assert.deepEqual(optionsFrom(env), { defaultModel: 'gemini-x' })
  assert.deepEqual(env, { KEEP: '1' })
})
