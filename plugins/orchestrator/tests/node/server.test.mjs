// The MCP server as Claude Code runs it, end to end: it starts the shared daemon, which runs the scripted agent in
// place of agy, answers a wait, leaves the session a notice for an async task, and outlives the server.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../../server/main.mjs', import.meta.url))
const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url))

/** @type {string} */
let home
/** @type {string} */
let state
let daemonPid = 0
// Under /tmp: a socket path has a short length limit, which a macOS temporary folder can pass.
before(async () => {
  home = await mkdtemp('/tmp/orch-')
  state = join(home, '.local', 'state', 'spider-orchestrator')
  await mkdir(join(home, 'bin'))
  await mkdir(join(home, 'proj'))
  await writeFile(join(home, 'bin', 'agy'), `#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`)
  await chmod(join(home, 'bin', 'agy'), 0o755)
})
after(async () => {
  if (daemonPid) {
    try {
      process.kill(daemonPid, 'SIGKILL')
    } catch {}
  }
  await rm(home, { recursive: true, force: true })
})

function serve() {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e', CLAUDE_PROJECT_DIR: join(home, 'proj'), SPIDER_ORCHESTRATOR_OPTION_AGY_PATH: join(home, 'bin', 'agy'), SPIDER_ORCHESTRATOR_OPTION_MAX_RUNTIME_MODE: 'approval-required', SPIDER_ORCHESTRATOR_OPTION_TASK_MINUTES: '${user_config.taskMinutes}', FAKE_AGENT_SCRIPT: JSON.stringify({ steps: [{ say: 'Reviewed: fine.' }] }), FAKE_AGENT_LOG: join(home, 'agent.log') }
  delete env.XDG_STATE_HOME
  const child = spawn(process.execPath, [MAIN], { env, stdio: ['pipe', 'pipe', 'inherit'] })
  /** @type {Map<number, (message: any) => void>} */
  const waiting = new Map()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
  })
  let ids = 0
  return {
    /** @param {string} method @param {object} [params] @returns {Promise<any>} */
    request: (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++ids
        waiting.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      }),
    /** @param {string} name @param {object} args */
    call: async (name, args) => {
      const reply = await new Promise((resolve) => {
        const id = ++ids
        waiting.set(id, resolve)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
      })
      return { isError: /** @type {any} */ (reply).result.isError === true, value: JSON.parse(/** @type {any} */ (reply).result.content[0].text) }
    },
    stop: () => new Promise((resolve) => (child.once('exit', resolve), child.kill())),
  }
}

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('the server lists the four tools, starts the daemon, and a delegated task runs agy acp in the session folder', async () => {
  const server = serve()
  const hello = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  assert.equal(hello.result.serverInfo.name, 'orchestrator')
  const listed = await server.request('tools/list')
  assert.deepEqual(listed.result.tools.map((/** @type {any} */ tool) => tool.name), ['orchestrator_capabilities', 'delegate_task', 'task_status', 'task_cancel'])

  const capabilities = await server.call('orchestrator_capabilities', {})
  assert.equal(capabilities.value.providers[0].available, true)
  assert.deepEqual(capabilities.value.runtimeModes, ['approval-required'])

  const escalated = await server.call('delegate_task', { task: 'Edit it', runtimeMode: 'full-access' })
  assert.equal(escalated.isError, true)
  assert.equal(escalated.value.error.code, 'runtime_mode_escalation_denied')

  const waited = await server.call('delegate_task', { task: 'Review sum.ts', mode: 'wait', title: 'Review' })
  assert.equal(waited.isError, false)
  assert.equal(waited.value.status, 'completed')
  assert.equal(waited.value.summary, 'Reviewed: fine.')
  const starts = (await readFile(join(home, 'agent.log'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.start)
  assert.deepEqual(starts.at(-1).start.argv, ['acp', '--cli_dir_name=spider-orchestrator', '--sandbox'])
  assert.equal(starts.at(-1).start.cwd.endsWith('/proj'), true)
  const profile = JSON.parse(await readFile(join(home, '.gemini', 'antigravity-cli', 'spider-orchestrator', 'settings.json'), 'utf8'))
  assert.deepEqual(profile, { toolPermission: 'request-review', allowNonWorkspaceAccess: false })

  const started = await server.call('delegate_task', { task: 'Look again', title: 'Second look' })
  assert.equal(started.value.next.startsWith('Completion wakes this thread'), true)
  const inbox = join(state, 'inbox', 'sess-e2e')
  let notice
  for (let i = 0; i < 100 && !notice; i++) {
    const names = await readdir(inbox).catch(() => [])
    if (names.length) notice = JSON.parse(await readFile(join(inbox, names[0] ?? ''), 'utf8'))
    else await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(notice.taskId, started.value.taskId)
  assert.match(notice.text, /\("Second look"\) on agy \(gemini-4-argon-medium\) completed\. Its result:\n\nReviewed: fine\./)

  const status = await server.call('task_status', { taskId: started.value.taskId })
  assert.equal(status.value.workState, 'result_available')
  assert.deepEqual(await readdir(inbox), [])

  await server.stop()
  daemonPid = Number(/pid (\d+)/.exec(await readFile(join(state, 'daemon.log'), 'utf8'))?.[1])
  assert.equal(alive(daemonPid), true, 'the daemon outlives the session')
  assert.equal(((await stat(state)).mode & 0o777).toString(8), '700')

  // SIGTERM stops the daemon, which removes its socket.
  process.kill(daemonPid, 'SIGTERM')
  for (let i = 0; i < 50 && alive(daemonPid); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(alive(daemonPid), false)
  assert.equal((await readdir(state)).some((name) => name.endsWith('.sock')), false)
})
