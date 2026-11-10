// Moves the Claude Code CLI pin: the exact version in package.json and its lockfile, and the version the root README
// says the repository is checked with (check-consistency keeps the two equal).
// Run: node scripts/bump-cli.mjs [version]   (no version: the one npm serves as `latest`, when it is newer than the pin)
// It prints the new version when the pin moved and nothing when it was already there; .github/workflows/cli-pin.yml
// reads that to decide whether to open a pull request. After a move by hand: npm ci, then npm run plugins:types.
// `pinnedCli(manifest)`, `newer(a, b)` and `movePin({ manifest, readme }, version)` are the pure core, on the files' text.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI_PACKAGE = '@anthropic-ai/claude-code'
const PIN = /("@anthropic-ai\/claude-code":\s*")([^"]+)(")/
const CHECKED = /(checked with v)\d+(?:\.\d+)*/

/** The CLI version package.json pins. */
export function pinnedCli(manifest) {
  return JSON.parse(manifest).devDependencies[CLI_PACKAGE]
}

/** Whether exact version `a` is after `b`. */
export function newer(a, b) {
  const [x, y] = [a, b].map(version => version.split('.').map(Number))
  const at = x.findIndex((part, index) => part !== y[index])
  return at !== -1 && x[at] > y[at]
}

/** The text of package.json and the root README with the pin at `version`; the lockfile is npm's to rewrite. */
export function movePin({ manifest, readme }, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not an exact version (X.Y.Z)`)
  if (!CHECKED.test(readme)) throw new Error('README.md does not say which version the repository is checked with ("checked with vX.Y.Z")')
  return { manifest: manifest.replace(PIN, `$1${version}$3`), readme: readme.replace(CHECKED, `$1${version}`) }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [asked, ...extra] = process.argv.slice(2)
  // BUMP_CLI_ROOT is read only here, by the CLI: the tests point it at a temporary repository. Unset, it is this checkout.
  const root = process.env.BUMP_CLI_ROOT || fileURLToPath(new URL('..', import.meta.url))
  const npm = (...args) => execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    if (extra.length) throw new Error('usage: node scripts/bump-cli.mjs [version]')
    const files = { manifest: readFileSync(join(root, 'package.json'), 'utf8'), readme: readFileSync(join(root, 'README.md'), 'utf8') }
    const pin = pinnedCli(files.manifest)
    const version = asked ?? npm('view', CLI_PACKAGE, 'version').trim()
    const moved = movePin(files, version)
    const write = texts => {
      writeFileSync(join(root, 'package.json'), texts.manifest)
      writeFileSync(join(root, 'README.md'), texts.readme)
    }
    if (pin === version && moved.readme === files.readme) {
      console.error(`the pin is already at ${version}`)
    } else if (!asked && newer(pin, version)) {
      // npm's `latest` tag can move back; only a version asked for by name moves the pin back.
      console.error(`the pin stays at ${pin}: npm serves ${version} as latest, which is older`)
    } else {
      write(moved)
      try {
        npm('install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund')
      } catch (error) {
        write(files) // the lockfile did not follow, so neither do the other two
        throw error
      }
      console.error(`the pin moved from ${pin} to ${version}`)
      console.log(version)
    }
  } catch (error) {
    console.error(`bump-cli: ${error.message}`)
    process.exit(1)
  }
}
