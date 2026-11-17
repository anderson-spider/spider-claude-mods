import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { dispositionOf, outcomeOf } from '../../daemon/policy.mjs'

/** @type {string} */
let root
before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orch-policy-')))
  await mkdir(join(root, 'work', 'src'), { recursive: true })
  await mkdir(join(root, 'outside'))
  await symlink(join(root, 'outside'), join(root, 'work', 'escape'))
})
after(() => rm(root, { recursive: true, force: true }))

test('reads pass in every mode; full-access passes everything; approval-required asks for anything else', () => {
  const cwd = join(root, 'work')
  for (const mode of /** @type {const} */ (['approval-required', 'auto-accept-edits', 'full-access'])) {
    for (const kind of ['read', 'search', 'think']) assert.equal(dispositionOf(mode, cwd, { kind }), 'allow')
  }
  for (const kind of ['edit', 'delete', 'move', 'execute', 'fetch', 'other', undefined]) {
    assert.equal(dispositionOf('full-access', cwd, { kind }), 'allow')
    assert.equal(dispositionOf('approval-required', cwd, { kind, locations: [{ path: join(cwd, 'a.ts') }] }), 'ask')
  }
})

test('read-only passes reads and refuses everything else at once, inside the folder too', () => {
  const cwd = join(root, 'work')
  for (const kind of ['read', 'search', 'think']) assert.equal(dispositionOf('read-only', cwd, { kind }), 'allow')
  for (const kind of ['edit', 'delete', 'move', 'execute', 'fetch', 'other', undefined]) {
    assert.equal(dispositionOf('read-only', cwd, { kind, locations: [{ path: join(cwd, 'src', 'a.ts') }] }), 'deny')
  }
})

test('auto-accept-edits passes a mutation only inside the work folder, symlinks resolved, and asks for commands', () => {
  const cwd = join(root, 'work')
  const at = (/** @type {string[]} */ ...paths) => paths.map((path) => ({ path }))
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'edit', locations: at(join(cwd, 'src', 'new.ts')) }), 'allow')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'edit', locations: at('src/relative.ts') }), 'allow')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'delete', locations: at(join(root, 'outside', 'x')) }), 'deny')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'edit', locations: at(join(cwd, 'escape', 'x')) }), 'deny')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'edit', locations: at(join(cwd, '..', 'outside', 'y')) }), 'deny')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'move', locations: at(join(cwd, 'a'), join(root, 'outside', 'b')) }), 'deny')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'edit', locations: [] }), 'deny')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'edit' }), 'deny')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'execute' }), 'ask')
  assert.equal(dispositionOf('auto-accept-edits', cwd, { kind: 'fetch' }), 'ask')
})

test("the answer picks the agent's own once option, else the first of its kind, else cancelled", () => {
  const options = [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'no' }]
  assert.deepEqual(outcomeOf('allow', options), { outcome: { outcome: 'selected', optionId: 'once' } })
  assert.deepEqual(outcomeOf('ask', options), { outcome: { outcome: 'selected', optionId: 'no' } })
  assert.deepEqual(outcomeOf('deny', [{ kind: 'reject_always', optionId: 'never' }]), { outcome: { outcome: 'selected', optionId: 'never' } })
  assert.deepEqual(outcomeOf('deny', [{ kind: 'allow_once', optionId: 'once' }]), { outcome: { outcome: 'cancelled' } })
  assert.deepEqual(outcomeOf('allow', undefined), { outcome: { outcome: 'cancelled' } })
})
