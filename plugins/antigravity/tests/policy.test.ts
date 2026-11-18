import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decide, type Scope } from '../cli/policy.ts'

async function layout() {
  const top = await realpath(await mkdtemp(join(tmpdir(), 'antigravity-policy-')))
  const tree = join(top, 'tree')
  const outside = join(top, 'outside')
  await mkdir(join(tree, 'src'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(tree, '.git'), 'gitdir: /somewhere\n')
  await writeFile(join(outside, 'secret'), 'x')
  await symlink(outside, join(tree, 'out-link'))
  await symlink(join(tree, '.git'), join(tree, 'git-link'))
  const scope: Scope = { cwd: tree, readRoots: [tree], writeRoots: [tree] }
  return { tree, outside, scope }
}

const at = (...paths: string[]) => ({ locations: paths.map(path => ({ path })) })

test('reads stay inside the roots, symlinks resolved, and must name a file', async () => {
  const { tree, outside, scope } = await layout()
  assert.equal(decide('read-only', scope, { kind: 'read', ...at(join(tree, 'src', 'a.ts')) }).allow, true)
  assert.equal(decide('read-only', scope, { kind: 'read', ...at('src/new.ts') }).allow, true)
  assert.equal(decide('read-only', scope, { kind: 'read', ...at(join(outside, 'secret')) }).allow, false)
  assert.equal(decide('read-only', scope, { kind: 'read', ...at('out-link/secret') }).allow, false)
  assert.deepEqual(decide('read-only', scope, { kind: 'read' }), { allow: false, reason: 'a read that names no file' })
  assert.deepEqual(decide('read-only', scope, { kind: 'search', locations: [] }), { allow: false, reason: 'a read that names no file' })
})

test('a path with .. is refused, as the OS resolves it after a symlink', async () => {
  const { tree, scope } = await layout()
  // missing/../out-link/secret collapses lexically to a path inside, yet reaches outside.
  assert.equal(decide('read-only', scope, { kind: 'read', ...at(join(tree, 'missing', '..', 'out-link', 'secret')) }).allow, false)
  assert.equal(decide('implement', scope, { kind: 'edit', ...at('out-link/../src/a.ts') }).allow, false)
  assert.equal(decide('read-only', scope, { kind: 'read', ...at('src/../src/a.ts') }).reason, 'a read with a malformed location')
})

test('implement edits only its worktree, never .git or .gitattributes', async () => {
  const { tree, outside, scope } = await layout()
  assert.equal(decide('implement', scope, { kind: 'edit', ...at(join(tree, 'src', 'a.ts')) }).allow, true)
  assert.equal(decide('implement', scope, { kind: 'edit', ...at(join(outside, 'secret')) }).allow, false)
  for (const path of ['.git', '.git/config', 'sub/.git/config', '.gitattributes', 'src/.GitAttributes', 'git-link']) {
    assert.deepEqual(decide('implement', scope, { kind: 'edit', ...at(path) }), { allow: false, reason: 'an edit of .git or .gitattributes' }, path)
  }
  assert.equal(decide('read-only', scope, { kind: 'edit', ...at('src/a.ts') }).reason, 'read-only')
  assert.equal(decide('implement', scope, { kind: 'execute' }).reason, 'commands are not allowed')
  assert.equal(decide('implement', scope, { kind: 'fetch' }).allow, true)
})
