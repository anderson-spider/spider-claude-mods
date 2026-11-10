// Fails when a pull request breaks the rules the release workflow (.github/workflows/release.yml) depends on:
//   - nobody but the release pull request edits a plugin's `version`, and a new plugin starts at 0.0.0;
//   - the title is a Conventional Commit whose type releases exactly when a plugin's shipped files changed, since the
//     squash commit carries that title and release-please reads it to pick each plugin's next version.
// Run: node scripts/check-release.mjs <base-ref> [--worktree]   (CI passes origin/<base branch>)
// --worktree also counts uncommitted and untracked files and reads the head version from disk, for checks before a commit.
// The pull request comes from the environment: PR_TITLE (unset: the title is not checked, as before a pull request
// exists), PR_AUTHOR and PR_HEAD, and RELEASE_BOT, the login release pull requests are opened with.
// NOT_SHIPPED is the one definition of which plugin files ship; docs and skills point here instead of restating it.
// `shippedPlugins(files)`, `touchedPlugins(files)`, `versionEdits(changed, versionAt)`,
// `titleErrors(title, shipped, touched)` and `isReleasePr(pr, bot)` are the pure core.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Inside a plugin everything ships (hooks, helper, skills, types, manifests, config) except tests and docs.
const NOT_SHIPPED = [
  /^(?:tests|helper\/test|docs)\//, // test suites and docs folders
  /^[^/]+\.md$/, // README.md, AGENTS.md, CHANGELOG.md at the plugin root; a skill's SKILL.md sits deeper and counts
  /\.test\.[cm]?[jt]sx?$/, // a test file beside its module
]
// The types release-please opens a release for (`changelog-sections` in release-please-config.json), and the rest.
const RELEASING = ['feat', 'fix', 'perf', 'refactor', 'revert']
const QUIET = ['build', 'chore', 'ci', 'docs', 'style', 'test']
const NEW_PLUGIN_VERSION = '0.0.0'
// The head branch of release-please's pull request starts with this.
const RELEASE_BRANCH = 'release-please--'

/** The plugins with at least one changed file that ships, sorted. `files` are repository-relative paths. */
export function shippedPlugins(files) {
  const names = new Set()

  for (const file of files) {
    const match = /^plugins\/([^/]+)\/(.+)$/.exec(file)
    if (match && !NOT_SHIPPED.some(pattern => pattern.test(match[2]))) names.add(match[1])
  }

  return [...names].sort()
}

/** The plugins with any changed file, shipped or not, sorted: release-please counts a commit for each of them. */
export function touchedPlugins(files) {
  return [...new Set(files.flatMap(file => /^plugins\/([^/]+)\/./.exec(file)?.[1] ?? []))].sort()
}

/**
 * One line per plugin whose version was edited by hand, or that is new and does not start at 0.0.0.
 * `versionAt(side, name)` returns the plugin.json version on the `'base'` or `'head'` side, or undefined when the
 * manifest is not there (a new plugin on the base side, a removed one on the head side).
 */
export function versionEdits(changed, versionAt) {
  const errors = []

  for (const name of shippedPlugins(changed)) {
    const before = versionAt('base', name)
    const after = versionAt('head', name)
    if (after === undefined) continue
    if (before === undefined) {
      if (after !== NEW_PLUGIN_VERSION) errors.push(`${name}: a new plugin starts at ${NEW_PLUGIN_VERSION}, not ${after}; its first release sets the version`)
    } else if (before !== after) {
      errors.push(`${name}: version changed from ${before} to ${after}; leave it at ${before}, the release pull request sets it`)
    }
  }

  return errors
}

/**
 * What is wrong with a pull request title, given the plugins whose shipped files it changes (`shipped`) and the ones it
 * changes at all (`touched`); at most one line.
 */
export function titleErrors(title, shipped, touched = shipped) {
  const match = /^([a-z]+)(?:\([^()\s]+\))?(!)?: \S/.exec(title)
  if (!match || ![...RELEASING, ...QUIET].includes(match[1])) {
    return [`title "${title}" is not a Conventional Commit: write type(scope): description, with type one of ${[...RELEASING, ...QUIET].join(', ')}`]
  }
  const releases = RELEASING.includes(match[1]) || match[2] === '!'
  if (shipped.length && !releases) return [`title type "${match[1]}" opens no release, but shipped files changed in ${shipped.join(', ')}: use one of ${RELEASING.join(', ')}`]
  if (!shipped.length && releases) return [`title type "${match[1]}${match[2] ?? ''}" opens a release, but no plugin's shipped files changed: use one of ${QUIET.join(', ')}`]
  // release-please would release these too: it cannot tell a plugin's tests and docs from what ships.
  const idle = touched.filter(name => !shipped.includes(name))
  if (releases && idle.length) return [`title type "${match[1]}${match[2] ?? ''}" opens a release, but only tests or docs changed in ${idle.join(', ')}: move that to a pull request of its own`]
  return []
}

/** Whether `pr` (`{ author, head }`) is the release pull request: opened by `bot` from release-please's branch. */
export function isReleasePr(pr, bot) {
  return Boolean(bot) && pr.author === bot && (pr.head ?? '').startsWith(RELEASE_BRANCH)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, mode] = process.argv.slice(2)
  const worktree = mode === '--worktree'

  if (!base || base.startsWith('-') || (mode !== undefined && !worktree)) {
    console.error('usage: node scripts/check-release.mjs <base-ref> [--worktree]')
    process.exit(2)
  }
  if (isReleasePr({ author: process.env.PR_AUTHOR, head: process.env.PR_HEAD }, process.env.RELEASE_BOT)) {
    console.log('ok: the release pull request')
    process.exit(0)
  }

  // stderr is dropped: `git show` of a new plugin's manifest at the base says `fatal`, which is expected there.
  // Run from the top level: `ls-files` lists only below the current directory, and paths are read relative to the root.
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  // --no-renames lists both paths of a move, so a file leaving the shipped set (to docs/ or tests/) or the plugin counts.
  const lines = text => text.split('\n').filter(Boolean)
  // The working tree is compared with the merge base, as `base...HEAD` does for commits.
  const changed = worktree
    ? [...lines(git('diff', '--name-only', '--no-renames', git('merge-base', base, 'HEAD').trim())), ...lines(git('ls-files', '--others', '--exclude-standard'))]
    : lines(git('diff', '--name-only', '--no-renames', `${base}...HEAD`))
  const manifest = name => `plugins/${name}/.claude-plugin/plugin.json`
  const versionAt = (side, name) => {
    try {
      if (side === 'head' && worktree) return JSON.parse(readFileSync(join(root, manifest(name)), 'utf8')).version
      return JSON.parse(git('show', `${side === 'base' ? base : 'HEAD'}:${manifest(name)}`)).version
    } catch {
      return undefined
    }
  }
  const title = process.env.PR_TITLE
  // A removed plugin has nothing left to release, so its deleted files ask for no releasing type.
  const left = name => versionAt('head', name) !== undefined
  const errors = [...versionEdits(changed, versionAt), ...(title === undefined ? [] : titleErrors(title, shippedPlugins(changed).filter(left), touchedPlugins(changed).filter(left)))]

  if (errors.length) {
    console.error(errors.join('\n'))
    process.exit(1)
  }

  console.log(title === undefined ? 'ok: no plugin version was edited' : 'ok: no plugin version was edited and the title matches what changed')
}
