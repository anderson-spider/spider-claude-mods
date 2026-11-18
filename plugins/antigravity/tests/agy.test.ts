import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HOME_CONFIG, PROFILE, PROFILE_SETTINGS, agyEnv, firstLine, locateAgy, parseModels, pathsOf, prepareHome, privateDir } from '../cli/agy.ts'
import { MODELS_TEXT, fakeAgyDir } from './fake-agy.ts'

const scratch = () => mkdtemp(join(tmpdir(), 'antigravity-test-'))

test('parseModels reads id and name per line, skipping the fetching line, and marks third-party models', () => {
  assert.deepEqual(parseModels(MODELS_TEXT), [
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)', thirdParty: false },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', thirdParty: false },
    { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)', thirdParty: true },
  ])
  assert.deepEqual(parseModels('Fetching available models...\nError: not signed in\n'), [])
})

test('firstLine keeps the first non-empty line with Google Cloud projects and regions blanked', () => {
  assert.equal(firstLine('\n  Error: projects/acme-123/locations/us-central1/models: quota\nmore'), 'Error: projects/…/locations/…/models: quota')
  assert.equal(firstLine('denied for project_id: acme-123 today'), 'denied for project … today')
  assert.equal(firstLine(undefined), '')
})

test('pathsOf uses XDG_STATE_HOME when absolute, else ~/.local/state', () => {
  assert.equal(pathsOf({ HOME: '/h', XDG_STATE_HOME: '/x' }).geminiDir, '/x/spider-antigravity/gemini')
  assert.equal(pathsOf({ HOME: '/h', XDG_STATE_HOME: 'relative' }).state, '/h/.local/state/spider-antigravity')
  assert.equal(pathsOf({ HOME: '/h' }).tasks, '/h/.local/state/spider-antigravity/tasks')
})

test('agyEnv drops the ambient Google and agy variables only', () => {
  assert.deepEqual(agyEnv({ PATH: '/bin', HOME: '/h', GEMINI_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p', AGY_X: '1', CLOUDSDK_CONFIG: 'c', MY_GOOGLE: 'stays' }), { PATH: '/bin', HOME: '/h', MY_GOOGLE: 'stays' })
})

test('locateAgy takes agyPath, then PATH, and explains what is missing', async () => {
  const dir = await fakeAgyDir()
  assert.equal(await locateAgy(undefined, { PATH: dir, HOME: '/nonexistent' }), join(dir, 'agy'))
  assert.equal(await locateAgy(join(dir, 'agy'), { PATH: '' }), join(dir, 'agy'))
  assert.match((await locateAgy('agy', {}) as { error: string }).error, /absolute path/)
  assert.match((await locateAgy(join(dir, 'missing'), {}) as { error: string }).error, /not an executable/)
  assert.match((await locateAgy(undefined, { PATH: '/nonexistent', HOME: '/nonexistent' }) as { error: string }).error, /agy was not found/)
})

test('privateDir creates a 700 folder, narrows a wider one and refuses a symlink', async () => {
  const root = await scratch()
  assert.equal(await privateDir(join(root, 'a')), undefined)
  assert.equal((await stat(join(root, 'a'))).mode & 0o777, 0o700)
  await mkdir(join(root, 'b'), { mode: 0o755 })
  await chmod(join(root, 'b'), 0o755)
  assert.equal(await privateDir(join(root, 'b')), undefined)
  assert.equal((await stat(join(root, 'b'))).mode & 0o777, 0o700)
  await symlink(join(root, 'a'), join(root, 'link'))
  assert.match((await privateDir(join(root, 'link'))) ?? '', /not a plain folder/)
  assert.ok((await lstat(join(root, 'link'))).isSymbolicLink())
})

test('prepareHome writes the profile settings and agy config into the private home', async () => {
  const paths = pathsOf({ HOME: '/h', XDG_STATE_HOME: await scratch() })
  assert.equal(await prepareHome(paths), undefined)
  assert.deepEqual(JSON.parse(await readFile(join(paths.geminiDir, 'antigravity-cli', PROFILE, 'settings.json'), 'utf8')), PROFILE_SETTINGS)
  assert.deepEqual(JSON.parse(await readFile(join(paths.geminiDir, 'config', 'config.json'), 'utf8')), HOME_CONFIG)
  // agy itself leaves an empty mcp_config.json there.
  await writeFile(join(paths.geminiDir, 'config', 'mcp_config.json'), '')
  assert.equal(await prepareHome(paths), undefined)
})

test('prepareHome refuses a home with MCP servers, hooks, plugins or skills', async () => {
  const paths = pathsOf({ HOME: '/h', XDG_STATE_HOME: await scratch() })
  await prepareHome(paths)
  const config = join(paths.geminiDir, 'config')
  await writeFile(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: { memory: { command: 'x' } } }))
  await writeFile(join(config, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [] } }))
  await mkdir(join(config, 'skills', 'one'), { recursive: true })
  const refused = (await prepareHome(paths)) ?? ''
  assert.match(refused, /MCP servers in config\/mcp_config.json, hooks in config\/hooks.json, skills in config\/skills/)
  await writeFile(join(config, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(config, 'hooks.json'), 'not json')
  assert.match((await prepareHome(paths)) ?? '', /^The plugin's agy home .* has hooks in config\/hooks.json, skills in config\/skills,/)
})
