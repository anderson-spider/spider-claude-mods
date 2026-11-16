// Tests for findings.mjs. Run: node --test plugins/antigravity/skills/review-publish/scripts/findings.test.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test, beforeEach, afterEach } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ENUMS, EXAMPLE, FIELDS, githubPayload, gitlabInputs, labelOf, locate, obtainDiff, parseDiff, place, schemaText, validateFields,
} from './findings.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'findings.mjs')

// git in these tests, and in the script they run, reads no user or system config
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
})

const MODIFY = `diff --git a/src/a.py b/src/a.py
index 111..222 100644
--- a/src/a.py
+++ b/src/a.py
@@ -1,4 +1,5 @@
 one
-two
+TWO
+two-b
 three
 four
`

const RENAME = `diff --git a/old.py b/new.py
similarity index 80%
rename from old.py
rename to new.py
index 111..222 100644
--- a/old.py
+++ b/new.py
@@ -1,2 +1,2 @@
 keep
-gone
+added
`

const NEW_FILE = `diff --git a/fresh.txt b/fresh.txt
new file mode 100644
index 0000000..111
--- /dev/null
+++ b/fresh.txt
@@ -0,0 +1,2 @@
+a
+b
`

const DELETED_FILE = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 111..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`

const QUOTED_PATHS = `diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"
index 111..222 100644
--- "a/we\\"ird.txt"
+++ "b/we\\"ird.txt"
@@ -1 +1 @@
-x
+y
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
index 111..222 100644
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-x
+y
diff --git a/with space.txt b/with space.txt
index 111..222 100644
--- a/with space.txt\t
+++ b/with space.txt\t
@@ -1 +1 @@
-x
+y
`

const NO_NEWLINE = `diff --git a/f.txt b/f.txt
index 111..222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 first
-last
\\ No newline at end of file
+last
\\ No newline at end of file
`

const DASHED_CONTENT = `diff --git a/q.sql b/q.sql
index 111..222 100644
--- a/q.sql
+++ b/q.sql
@@ -1,2 +1,2 @@
 keep
--- sql comment
+++ plus line
`

const TWO_HUNKS_TWO_FILES = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 a1
-a2
+A2
@@ -10,2 +10,3 @@
 a10
+a10b
 a11
diff --git a/b.txt b/b.txt
index 111..222 100644
--- a/b.txt
+++ b/b.txt
@@ -5 +5 @@
-b5
+B5
`

const RENAME_ONLY_AND_BINARY = `diff --git a/same.py b/moved.py
similarity index 100%
rename from same.py
rename to moved.py
diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`

const finding = overrides => ({ path: 'src/a.py', line: 2, side: 'new', severity: 'minor', raisedBy: ['Gemini'], body: 'comment', ...overrides })
const lines = entries => new Map(entries)

describe('parseDiff', () => {
  test('a modified file maps new lines to old lines', () => {
    const d = parseDiff(MODIFY).get('src/a.py')
    assert.equal(d.old, 'src/a.py')
    assert.equal(d.new, 'src/a.py')
    assert.deepEqual(d.new_lines, lines([[1, 1], [2, null], [3, null], [4, 3], [5, 4]]))
    assert.deepEqual(d.removed, new Set([2]))
  })

  test('a rename is reachable by both paths', () => {
    const files = parseDiff(RENAME)
    assert.equal(files.get('old.py'), files.get('new.py'))
    assert.deepEqual([files.get('new.py').old, files.get('new.py').new], ['old.py', 'new.py'])
  })

  test('a new file has no old path', () => {
    const d = parseDiff(NEW_FILE).get('fresh.txt')
    assert.equal(d.old, null)
    assert.deepEqual(d.new_lines, lines([[1, null], [2, null]]))
    assert.deepEqual(d.removed, new Set())
  })

  test('a deleted file has no new path', () => {
    const d = parseDiff(DELETED_FILE).get('gone.txt')
    assert.equal(d.new, null)
    assert.deepEqual(d.removed, new Set([1, 2]))
    assert.deepEqual(d.new_lines, new Map())
  })

  test('quoted paths are decoded', () => {
    const files = parseDiff(QUOTED_PATHS)
    assert.ok(files.has('we"ird.txt'))
    assert.ok(files.has('café.txt'))
  })

  test('a path with a space drops the trailing tab', () => {
    assert.ok(parseDiff(QUOTED_PATHS).has('with space.txt'))
  })

  test('the no-newline marker does not shift line numbers', () => {
    const d = parseDiff(NO_NEWLINE).get('f.txt')
    assert.deepEqual(d.new_lines, lines([[1, 1], [2, null]]))
    assert.deepEqual(d.removed, new Set([2]))
  })

  test('content that looks like a file header stays a line', () => {
    const d = parseDiff(DASHED_CONTENT).get('q.sql')
    assert.deepEqual(d.removed, new Set([2]))
    assert.deepEqual(d.new_lines, lines([[1, 1], [2, null]]))
  })

  test('line numbers restart in each hunk and file', () => {
    const files = parseDiff(TWO_HUNKS_TWO_FILES)
    assert.deepEqual(files.get('a.txt').new_lines, lines([[1, 1], [2, null], [10, 10], [11, null], [12, 11]]))
    assert.deepEqual(files.get('a.txt').removed, new Set([2]))
    assert.deepEqual(files.get('b.txt').new_lines, lines([[5, null]]))
    assert.deepEqual(files.get('b.txt').removed, new Set([5]))
  })

  test('a rename without hunks and binary files have nothing to comment on', () => {
    assert.deepEqual(parseDiff(RENAME_ONLY_AND_BINARY), new Map())
  })

  test('an empty diff', () => {
    assert.deepEqual(parseDiff(''), new Map())
  })
})

describe('locate', () => {
  const files = parseDiff(MODIFY + RENAME + DELETED_FILE)

  test('added and context lines are on the diff', () => {
    for (const line of [2, 3, 4]) {
      const [d, reason] = locate(finding({ line }), files)
      assert.equal(reason, null, String(line))
      assert.equal(d, files.get('src/a.py'))
    }
  })

  test('a new line outside a hunk', () => {
    assert.equal(locate(finding({ line: 99 }), files)[1], 'new line not in a hunk')
  })

  test('the old side takes a removed line only', () => {
    assert.equal(locate(finding({ side: 'old', line: 2 }), files)[1], null)
    assert.equal(locate(finding({ side: 'old', line: 1 }), files)[1], 'old line is not a removed line')
  })

  test('a renamed file takes the new path for new lines and the old path for old lines', () => {
    assert.equal(locate(finding({ path: 'new.py', line: 2 }), files)[1], null)
    assert.equal(locate(finding({ path: 'old.py', side: 'old', line: 2 }), files)[1], null)
    assert.match(locate(finding({ path: 'old.py', line: 2 }), files)[1], /takes the path 'new\.py'/)
    assert.match(locate(finding({ path: 'new.py', side: 'old', line: 2 }), files)[1], /takes the path 'old\.py'/)
  })

  test('a deleted file takes old lines', () => {
    assert.equal(locate(finding({ path: 'gone.txt', side: 'old', line: 1 }), files)[1], null)
  })

  test('a path not in the diff', () => {
    assert.equal(locate(finding({ path: 'other.py' }), files)[1], 'path not in the diff')
  })

  test('the shape is validated before the diff is consulted', () => {
    const { body, ...noBody } = finding()
    const cases = [
      [finding({ line: true }), "field 'line' missing or not int"],
      [finding({ line: '2' }), "field 'line' missing or not int"],
      [noBody, "field 'body' missing or not str"],
      [finding({ raisedBy: 'Gemini' }), "field 'raisedBy' missing or not list"],
      [finding({ severity: 'critical' }), "severity='critical' not in ['blocker', 'major', 'minor', 'nit']"],
      [finding({ side: 'left' }), "side='left' not in ['new', 'old']"],
    ]
    for (const [f, reason] of cases) assert.deepEqual(locate(f, files), [null, reason], JSON.stringify(f))
  })
})

describe('place and payloads', () => {
  const files = parseDiff(MODIFY + RENAME + DELETED_FILE)
  const items = [
    finding({ line: 3, body: 'added line' }),
    finding({ line: 99 }),
    'not a dict',
    finding({ line: 4, body: 'context line' }),
    finding({ path: 'gone.txt', side: 'old', line: 2, body: 'removed line' }),
  ]
  const placed = list => place(list, files).filter(([, , reason]) => !reason).map(([f, d]) => [f, d])

  test('place keeps the input order and the reasons', () => {
    assert.deepEqual(place(items, files).map(r => r[2]), [null, 'new line not in a hunk', 'not an object', null, null])
    assert.equal(labelOf('not a dict'), "'not a dict'")
    assert.equal(labelOf(items[1]), 'new src/a.py:99')
  })

  test('the github payload has no event and maps the sides', () => {
    const payload = githubPayload(placed(items), 'abc123', 'summary')
    assert.deepEqual(Object.keys(payload).sort(), ['body', 'comments', 'commit_id'])
    assert.equal(payload.commit_id, 'abc123')
    assert.equal(payload.body, 'summary')
    assert.deepEqual(payload.comments, [
      { path: 'src/a.py', line: 3, side: 'RIGHT', body: 'added line' },
      { path: 'src/a.py', line: 4, side: 'RIGHT', body: 'context line' },
      { path: 'gone.txt', line: 2, side: 'LEFT', body: 'removed line' },
    ])
  })

  test('the gitlab inputs are line draft notes that carry both line numbers on unchanged lines', () => {
    const at = { action: 'line', draft: true, iid: 7 }
    assert.deepEqual(gitlabInputs(placed(items), { iid: 7 }), [
      { ...at, path: 'src/a.py', line: 3, body: 'added line' },
      { ...at, path: 'src/a.py', line: 4, oldLine: 3, body: 'context line' },
      { ...at, path: 'gone.txt', oldLine: 2, body: 'removed line' },
    ])
  })

  test('the gitlab inputs carry host and project only when given', () => {
    const [input] = gitlabInputs(placed([finding({ line: 3 })]), { iid: 7, host: 'gitlab.example.com', project: 'group/app' })
    assert.deepEqual(input, { action: 'line', draft: true, host: 'gitlab.example.com', project: 'group/app', iid: 7, path: 'src/a.py', line: 3, body: 'comment' })
  })

  test('the gitlab inputs on a renamed file name the path of the finding’s side', () => {
    const inputs = gitlabInputs(placed([finding({ path: 'new.py', line: 2 }), finding({ path: 'old.py', side: 'old', line: 2 })]), { iid: 7 })
    assert.deepEqual(inputs.map(i => [i.path, i.line, i.oldLine]), [['new.py', 2, undefined], ['old.py', undefined, 2]])
  })
})

describe('schema', () => {
  test('the schema text lists every field and allowed value', () => {
    const text = schemaText()
    for (const name of Object.keys(FIELDS)) assert.ok(text.includes(`  ${name}:`), name)
    for (const allowed of Object.values(ENUMS)) for (const value of allowed) assert.ok(text.includes(value), value)
  })

  test('the example is a valid finding', () => {
    assert.equal(validateFields(EXAMPLE), null)
  })
})

/** A throwaway repo whose branch renames, quotes, deletes and adds files after `main`. */
function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'findings-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  const write = (name, content) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    writeFileSync(join(repo, name), content)
  }
  git('init', '-q', '-b', 'main')
  write('src/a.py', 'one\ntwo\nthree\nfour\n')
  write('old.py', 'keep\ngone\nline3\nline4\nline5\n')
  write('gone.txt', 'a\nb\n')
  write('we"ird.txt', 'x\n')
  write('café.txt', 'x\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('switch', '-q', '-c', 'feature')
  write('src/a.py', 'one\nTWO\ntwo-b\nthree\nfour\n')
  git('mv', 'old.py', 'new.py')
  write('new.py', 'keep\nadded\nline3\nline4\nline5\n')
  git('rm', '-q', 'gone.txt')
  write('we"ird.txt', 'y\n')
  write('café.txt', 'y\n')
  write('fresh.txt', 'p\nq\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'feature')
  return { repo, git, write }
}

describe('obtainDiff', () => {
  let r
  beforeEach(() => { r = gitRepo() })
  afterEach(() => rmSync(r.repo, { recursive: true, force: true }))

  test('real git output parses like the fixtures', () => {
    const files = parseDiff(obtainDiff('main', r.repo))
    assert.deepEqual(files.get('src/a.py').new_lines, lines([[1, 1], [2, null], [3, null], [4, 3], [5, 4]]))
    assert.equal(files.get('old.py'), files.get('new.py'))
    assert.deepEqual(files.get('gone.txt').removed, new Set([1, 2]))
    assert.deepEqual(files.get('fresh.txt').new_lines, lines([[1, null], [2, null]]))
    assert.deepEqual(files.get('we"ird.txt').removed, new Set([1]))
    assert.deepEqual(files.get('café.txt').removed, new Set([1]))
  })

  test('git config that reshapes the diff is overridden', () => {
    r.git('config', 'diff.noprefix', 'true')
    r.git('config', 'diff.mnemonicPrefix', 'true')
    r.git('config', 'diff.context', '0')
    r.git('config', 'core.quotePath', 'true')
    const files = parseDiff(obtainDiff('main', r.repo))
    assert.deepEqual(files.get('src/a.py').new_lines, lines([[1, 1], [2, null], [3, null], [4, 3], [5, 4]]))
    assert.ok(files.has('we"ird.txt'))
    assert.ok(files.has('café.txt'))
  })

  test('uncommitted and untracked work is not in the diff', () => {
    r.write('src/a.py', 'one\nTWO\ntwo-b\nthree\nfour\nfive\n')
    r.write('untracked.txt', 'u\n')
    const files = parseDiff(obtainDiff('main', r.repo))
    assert.ok(!files.get('src/a.py').new_lines.has(6))
    assert.ok(!files.has('untracked.txt'))
  })

  test('unusable fixed points throw with a reason', () => {
    assert.throws(() => obtainDiff('--output=x', r.repo), /looks like an option/)
    assert.throws(() => obtainDiff('no-such-ref', r.repo), /does not resolve to a commit/)
  })
})

describe('CLI', () => {
  let r
  beforeEach(() => { r = gitRepo() })
  afterEach(() => rmSync(r.repo, { recursive: true, force: true }))
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: r.repo, encoding: 'utf8' })
  const findingsFile = items => {
    const path = join(r.repo, 'findings.json')
    writeFileSync(path, JSON.stringify(items))
    return path
  }

  test('check prints one line per finding in order and fails on a miss', () => {
    const out = run('check', 'main', findingsFile([finding({ line: 3 }), finding({ line: 99 }), finding({ line: 4 })]))
    assert.equal(out.status, 1)
    assert.deepEqual(out.stdout.split('\n').filter(Boolean), ['ok   new src/a.py:3', 'FAIL new src/a.py:99: new line not in a hunk', 'ok   new src/a.py:4'])
  })

  test('check succeeds when every finding is on the diff', () => {
    const out = run('check', 'main', findingsFile([finding({ line: 3 })]))
    assert.deepEqual([out.status, out.stdout], [0, 'ok   new src/a.py:3\n'])
  })

  test('github leaves failures on stderr and accepts a body that starts with a dash', () => {
    const out = run('github', 'main', findingsFile([finding({ line: 3, body: 'kept' }), finding({ line: 99 })]), '--commit', 'abc', '--body', '- one finding is off the diff')
    assert.equal(out.status, 0, out.stderr)
    const payload = JSON.parse(out.stdout)
    assert.equal(payload.body, '- one finding is off the diff')
    assert.deepEqual(payload.comments.map(c => c.body), ['kept'])
    assert.match(out.stderr, /FAIL new src\/a\.py:99/)
  })

  test('github accepts a body that starts with a dash after an equals sign', () => {
    const out = run('github', 'main', findingsFile([]), '--commit', 'abc', '--body=-x')
    assert.equal(out.status, 0, out.stderr)
    assert.equal(JSON.parse(out.stdout).body, '-x')
  })

  test('github requires commit and body', () => {
    const out = run('github', 'main', findingsFile([]))
    assert.equal(out.status, 2)
    assert.match(out.stderr, /--commit/)
  })

  test('gitlab prints the gitlab_mr_comment inputs', () => {
    const out = run('gitlab', 'main', findingsFile([finding({ line: 4 })]), '--iid', '7')
    assert.equal(out.status, 0, out.stderr)
    assert.deepEqual(JSON.parse(out.stdout), [{ action: 'line', draft: true, iid: 7, path: 'src/a.py', line: 4, oldLine: 3, body: 'comment' }])
  })

  test('gitlab requires a positive integer iid', () => {
    const missing = run('gitlab', 'main', findingsFile([]))
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /--iid/)
    assert.equal(run('gitlab', 'main', findingsFile([]), '--iid', 'x').status, 2)
  })

  test('the findings file must be a JSON array', () => {
    const path = join(r.repo, 'findings.json')
    writeFileSync(path, '{}')
    const out = run('check', 'main', path)
    assert.equal(out.status, 1)
    assert.match(out.stderr, /must hold a JSON array/)
  })

  test('schema prints without a repo or findings', () => {
    const out = spawnSync(process.execPath, [SCRIPT, 'schema'], { cwd: tmpdir(), encoding: 'utf8' })
    assert.equal(out.status, 0)
    assert.match(out.stdout, /severity: str, one of blocker, major, minor, nit/)
  })

  test('an unknown command or option is a usage error', () => {
    assert.equal(run('nope').status, 2)
    assert.equal(run('check', 'main', findingsFile([]), '--bogus').status, 2)
  })
})
