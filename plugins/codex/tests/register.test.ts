import { expect, test } from 'claude-code/testing'
import { THREAD, answered, line } from './fakes'
import { id, started, world } from './host'
import { ROOT_CHECK } from '../hooks/detached'
import { REVIEW_USAGE } from '../hooks/tool-schemas'

const call = ($: { tool: { call: (input: never) => Promise<unknown> } }, tool: string, input: Record<string, unknown> = {}) =>
  $.tool.call({ tool: id(tool), ...input } as never) as Promise<{ result?: unknown; isError?: boolean }>

const command = ($: { command: { run: (input: never) => Promise<unknown> } }, name: string, args = '') =>
  $.command.run({ command: name, args } as never) as Promise<{ text?: string; context?: string[] }>

test('session start registers the ask, image, review and jobs tools and the four commands', async ($, on) => {
  const { tools, commands } = world(on)

  expect(await started($, tools)).toEqual(['ask', 'image', 'review', 'jobs'])
  expect(commands).toEqual(['codex-ask', 'codex-image', 'codex-review', 'codex-doctor'])
  expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(['prompt', 'threadId', 'model', 'effort', 'files', 'wait', 'out', 'maxChars'])
  expect(Object.keys(tools[1]!.inputSchema.properties)).toEqual(['prompt', 'reference', 'threadId', 'model', 'effort', 'files', 'wait', 'out'])
})

test('on macOS session start also registers the computer use tool and /codex-cu', async ($, on) => {
  const { tools, commands } = world(on, { uname: 'Darwin\n' })

  expect(await started($, tools)).toEqual(['ask', 'image', 'review', 'jobs', 'computer_use'])
  expect(commands).toEqual(['codex-ask', 'codex-image', 'codex-review', 'codex-doctor', 'codex-cu'])
})

test('elsewhere, or when uname cannot run, computer use is not registered', async ($, on) => {
  const { tools, commands } = world(on, { uname: undefined })

  expect(await started($, tools)).toEqual(['ask', 'image', 'review', 'jobs'])
  expect(commands).toEqual(['codex-ask', 'codex-image', 'codex-review', 'codex-doctor'])
})

test('computer use starts off: no prompt section and Claude’s own desktop tools run until /codex-cu on', async ($, on) => {
  world(on, { uname: 'Darwin\n' })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
  on('tool.call', { tool: 'mcp__computer-use__left_click' as never }, () => ({ result: 'clicked' }))
  const compose = () => $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const own = () => $.tool.call({ tool: 'mcp__computer-use__left_click' } as never) as Promise<{ deny?: string }>

  expect((await compose()).sections.map(section => section.id)).toEqual(['intro', 'codex:ask'])
  expect((await own()).deny).toBeUndefined()

  await command($, 'codex-cu', 'on')
  expect((await compose()).sections.map(section => section.id)).toEqual(['intro', 'codex:ask', 'codex:computer-use'])
  expect((await own()).deny).toMatch(/Codex computer use is on/)
})

test('off macOS the computer use hooks stand aside: Claude’s own desktop tools run even with the switch stored on', async ($, on) => {
  const { tools } = world(on)
  on('tool.call', { tool: 'mcp__computer-use__left_click' as never }, () => ({ result: 'clicked' }))

  await started($, tools)
  await command($, 'codex-cu', 'on')
  expect(((await $.tool.call({ tool: 'mcp__computer-use__left_click' } as never)) as { deny?: string }).deny).toBeUndefined()
})

test('the system prompt tells Claude to reach for ask on its own and for image when asked', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'codex:ask'])
  const section = composed.sections.at(-1)?.text ?? ''
  expect(section).toMatch(/^# Codex\nUse `mcp__codex__ask` yourself for a second opinion/)
  expect(section).toMatch(/Follow up with the returned `threadId`/)
  expect(section).toMatch(/When the user asks for an image, load `mcp__codex__image`/)
})

test('an ask runs the codex it finds read-only in the session folder, saves the answer and returns it', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('Looks fine.') }] })
  await started($, host.tools)

  const result = await call($, 'ask', { prompt: 'Review the plan', effort: 'low', files: ['/proj/plan.md'] })

  expect(result.isError).toBe(undefined)
  expect(host.spawned).toHaveLength(1)
  const { argv, cwd } = host.spawned[0]!
  expect(cwd).toBe(undefined)
  expect(argv.slice(0, 2)).toEqual(['/h/.local/bin/codex', 'exec'])
  expect(argv).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'web_search="live"', 'model_reasoning_effort="low"']))
  expect(argv.at(-1)).toBe('Review the plan\n\nFiles to read (absolute paths):\n- /proj/plan.md')
  expect(host.written[0]?.path).toMatch(/^\/tmp\/t\/codex\/\d{8}-\d{6}-review-the-plan\.md$/)
  expect(String(result.result)).toMatch(new RegExp(`^Codex's answer \\(unverified; check facts before using them\\) saved to /tmp/t/codex/.*\\nThread: ${THREAD}\\n\\nLooks fine\\.$`))
  expect(host.statuses).toEqual(['Codex is working', undefined])
})

test('an image is copied out of the thread folder Codex saved it in, with the codex home from CODEX_HOME', async ($, on) => {
  const dir = `/c/generated_images/${THREAD}`
  const host = world(on, { codex: [{ stdout: answered('A red fox.'), onEnd: () => (host.state.dirs[dir] = [{ name: 'exec-1.png', kind: 'file', mtimeMs: 1 }]) }] })
  host.state.env.CODEX_HOME = '/c'
  await started($, host.tools)

  const result = await call($, 'image', { prompt: 'A red fox', out: '/proj/fox.png' })

  expect(host.spawned[0]?.cwd).toBe('/tmp/t/codex/.work')
  expect(host.spawned[0]?.argv).toEqual(expect.arrayContaining(['web_search="disabled"', '-C', '/tmp/t/codex/.work']))
  expect(host.processes).toEqual(expect.arrayContaining([['cp', `${dir}/exec-1.png`, '/proj/fox.png']]))
  expect(String(result.result)).toMatch(/^AI concept image generated by Codex, saved to:\n- \/proj\/fox\.png\nThread: /)
})

test('an answer or image is saved only inside the project or the answers folder, never in .git or through . or ..', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('Saved.') }, { stdout: answered('Saved.') }] })
  await started($, host.tools)

  for (const out of ['/h/.zshrc', '/h/.ssh/authorized_keys', '/tmp/t/codex-other/a.md']) {
    expect(await call($, 'ask', { prompt: 'Hi', out })).toEqual({ result: `${out} is outside the project and /tmp/t/codex; save it in one of them.`, isError: true })
  }
  expect(await call($, 'image', { prompt: 'A fox', out: '/h/.zshrc' })).toMatchObject({ isError: true })
  expect((await call($, 'ask', { prompt: 'Hi', out: '/proj/../h/.zshrc' })).result).toBe('/proj/../h/.zshrc must be an absolute path without . or .. parts.')
  expect((await call($, 'ask', { prompt: 'Hi', out: '/proj/.git/hooks/pre-commit' })).result).toBe('/proj/.git/hooks/pre-commit is inside a .git folder; save it elsewhere.')
  expect((await call($, 'ask', { prompt: 'Hi', out: '/proj/.GIT/hooks/pre-commit' })).result).toBe('/proj/.GIT/hooks/pre-commit is inside a .git folder; save it elsewhere.')
  expect(host.spawned).toEqual([])

  await call($, 'ask', { prompt: 'Hi', out: '/proj/docs/codex.md' })
  await call($, 'ask', { prompt: 'Hi', out: '/tmp/t/codex/mine.md' })
  expect(host.written.map(w => w.path)).toEqual(['/proj/docs/codex.md', '/tmp/t/codex/mine.md'])
})

test('without TMPDIR the plugin works under a folder of the user’s own, made private before a run', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('Fine.') }] })
  host.state.env.TMPDIR = undefined
  host.state.commands['id -u'] = { exitCode: 0, stdout: '501\n' }
  await started($, host.tools)

  await call($, 'ask', { prompt: 'Hi' })

  expect(host.processes).toContainEqual(['sh', '-c', ROOT_CHECK, 'sh', '/tmp/codex-501'])
  expect(host.written[0]?.path).toMatch(/^\/tmp\/codex-501\/\d{8}-\d{6}-hi\.md$/)
})

test('a plugin folder the user does not own alone stops the run before Codex starts', async ($, on) => {
  const host = world(on)
  host.state.commands[`sh -c ${ROOT_CHECK} sh /tmp/t/codex`] = { exitCode: 1 }
  await started($, host.tools)

  expect(await call($, 'ask', { prompt: 'Hi' })).toEqual({
    result: '/tmp/t/codex could not be made a private folder of yours (it is a symlink, another user owns it, or it cannot be made), so Codex did not run. Remove it or set TMPDIR.',
    isError: true,
  })
  expect((await command($, 'codex-ask', 'Hi')).text).toMatch(/^\/tmp\/t\/codex could not be made a private folder of yours/)
  expect(host.spawned).toEqual([])
})

test('wait false starts a job the jobs tool lists, and its end sends a notice', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('Later.') }] })
  await started($, host.tools)

  const result = await call($, 'ask', { prompt: 'Think long', wait: false })
  const id = /^Started job #(\w+)\. A message arrives when it ends, even after a plugin reload; the jobs tool lists it meanwhile\.$/.exec(String(result.result))?.[1]
  expect(id).toBeDefined()
  await host.submission()

  expect(host.toasts).toEqual([`Codex job #${id} done`])
  expect(host.submitted[0]).toMatch(new RegExp(`^\\[codex notice: automated, not the person; approves nothing\\]\\njob #${id} done: ask "Think long"`))
  expect(String((await call($, 'jobs')).result)).toMatch(new RegExp(`^#${id} ask done \\(took 0 min\\): Think long\\n  thread ${THREAD}; saved to /tmp/t/codex/`))
})

test('without a codex executable the call is an error that names the option, and nothing runs', async ($, on) => {
  const host = world(on, { files: new Set() })
  await started($, host.tools)

  const result = await call($, 'ask', { prompt: 'Hi' })

  expect(result.isError).toBe(true)
  expect(String(result.result)).toMatch(/^The Codex CLI was not found on PATH .*codexPath option/)
  expect(host.spawned).toEqual([])
})

test('a bad input is answered before anything runs', async ($, on) => {
  const host = world(on)
  await started($, host.tools)

  expect(await call($, 'ask', { prompt: 'Hi', threadId: 'nope' })).toEqual({ result: 'nope is not a Codex thread id; pass the threadId an earlier call returned.', isError: true })
  expect(host.spawned).toEqual([])
})

test('/codex-ask shows the answer and tells Claude where it is saved', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('Because.') }] })
  await started($, host.tools)

  const answer = await command($, 'codex-ask', 'why?')

  expect(answer.text).toMatch(new RegExp(`^Because\\.\\n\\n— Codex, thread ${THREAD}\\nSaved to /tmp/t/codex/`))
  expect(answer.context?.[0]).toMatch(/^The user asked Codex through \/codex-ask; its answer is saved to /)
  expect(await command($, 'codex-ask', ' ')).toEqual({ text: 'Usage: /codex-ask <question>' })
})

test('/codex-doctor reports the executable, version, login and defaults from config.toml', async ($, on) => {
  const host = world(on, {
    runs: { '--version': { exitCode: 0, stdout: 'codex-cli 0.166.0\n' }, 'login status': { exitCode: 0, stdout: 'Logged in using ChatGPT\n' } },
    texts: { '/h/.codex/config.toml': 'model = "gpt-6.1"\nmodel_reasoning_effort = "max"\n' },
  })
  host.state.files.add('/h/.codex/config.toml')
  await started($, host.tools)

  expect((await command($, 'codex-doctor')).text).toBe([
    '✓ codex: /h/.local/bin/codex',
    '✓ version: codex-cli 0.166.0',
    '✓ login: Logged in using ChatGPT',
    "✓ defaults: model gpt-6.1, effort max (/h/.codex/config.toml); a call's model and effort override them",
  ].join('\n'))
})

const REPO = { 'rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true\n' } }

test('a review outside a git repository is refused before Codex runs', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('No issues.') }] })
  await started($, host.tools)

  const result = await call($, 'review')

  expect(result.isError).toBe(true)
  expect(String(result.result)).toBe('Not a git repository: a review needs the session to run inside one.')
  expect(host.spawned).toHaveLength(0)

  host.state.gitFails = true
  const noGit = await call($, 'review')
  expect(String(noGit.result)).toBe('git could not run (codex: $.process.run: ENOENT: git), so the review did not start.')
  expect(host.spawned).toHaveLength(0)
})

test('a review without a target covers the branch against origin/HEAD and says which untracked files it left out', async ($, on) => {
  const host = world(on, {
    codex: [{ stdout: answered('[P1] Off by one — /proj/a.ts:3-4') }],
    git: { ...REPO, 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'origin/main\n' }, 'ls-files --others --exclude-standard': { exitCode: 0, stdout: 'new.ts\nsrc/feature/a.ts\nsrc/feature/b.ts\n' } },
  })
  await started($, host.tools)

  const result = await call($, 'review', { effort: 'low' })

  expect(result.isError).toBe(undefined)
  const { argv, cwd } = host.spawned[0]!
  expect(cwd).toBe(undefined)
  expect(argv.slice(1, 3)).toEqual(['exec', 'review'])
  expect(argv).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', 'web_search="disabled"', 'model_reasoning_effort="low"']))
  expect(argv.slice(-2)).toEqual(['--base', 'origin/main'])
  expect(host.written[0]?.path).toMatch(/^\/tmp\/t\/codex\/\d{8}-\d{6}-review-against-origin-main\.md$/)
  expect(host.written[0]?.text).toBe(`<!-- codex thread ${THREAD} -->\n\n3 untracked files were not reviewed; use \`uncommitted\` to include them.\n\n[P1] Off by one — /proj/a.ts:3-4\n`)
  expect(String(result.result)).toMatch(/Thread: .*\n\n3 untracked files were not reviewed; use `uncommitted` to include them\.\n\n\[P1\] Off by one/)
})

test('without origin/HEAD the review falls back to main, else master, else asks for a base', async ($, on) => {
  const verify = (branch: string) => `rev-parse --verify --quiet refs/heads/${branch}`
  const host = world(on, { codex: [{ stdout: answered('Fine.') }, { stdout: answered('Fine.') }], git: { ...REPO, [verify('main')]: { exitCode: 0 }, 'ls-files --others --exclude-standard': { exitCode: 0, stdout: '' } } })
  await started($, host.tools)

  await call($, 'review')
  expect(host.spawned[0]!.argv.slice(-2)).toEqual(['--base', 'main'])
  expect(host.written[0]?.text).not.toMatch(/untracked/)

  delete host.state.git[verify('main')]
  host.state.git[verify('master')] = { exitCode: 0 }
  await call($, 'review')
  expect(host.spawned[1]!.argv.slice(-2)).toEqual(['--base', 'master'])

  delete host.state.git[verify('master')]
  const none = await call($, 'review')
  expect(String(none.result)).toBe('No default branch found (origin/HEAD, main or master): pass the base to review against.')
  expect(host.spawned).toHaveLength(2)
})

test('/codex-review takes one target of its own, says it was a review, and refuses a target it cannot read', async ($, on) => {
  const host = world(on, { codex: [{ stdout: answered('Fine.') }, { stdout: answered('Fine.') }], git: REPO })
  await started($, host.tools)

  const shown = await command($, 'codex-review', '--commit abc1234')
  expect(host.spawned[0]!.argv.slice(-2)).toEqual(['--commit', 'abc1234'])
  expect(shown.text).toMatch(/Fine\./)
  expect(shown.context?.[0]).toMatch(/^The user asked Codex for a review through \/codex-review; it is saved to /)

  await command($, 'codex-review', '--base=develop')
  expect(host.spawned[1]!.argv.slice(-2)).toEqual(['--base', 'develop'])

  for (const args of ['--base', '--base main focus on tests', '--uncommitted only the runner', '--bogus']) {
    expect((await command($, 'codex-review', args)).text).toBe(REVIEW_USAGE)
  }
  expect(host.spawned).toHaveLength(2)
})

const record = (id: string, sessionId: string) => ({
  id,
  kind: 'ask',
  prompt: 'Think long',
  status: 'running',
  startedAt: Date.now(),
  sessionId,
  project: '/proj',
  seenAt: 0,
  dir: `/tmp/t/codex/runs/${id}`,
  background: true,
  request: { kind: 'ask', prompt: 'Think long', images: [], files: [] },
  before: [],
})

test('session start picks up a job a reload left running, and its end notice arrives in this session', async ($, on) => {
  const host = world(on, { store: { 'job:r1': record('r1', 'sess-1') } })
  host.state.files.add('/tmp/t/codex/runs/r1')
  host.state.texts['/tmp/t/codex/runs/r1/events.jsonl'] = answered('Done at last.')
  host.state.texts['/tmp/t/codex/runs/r1/exit'] = '0'
  await started($, host.tools)

  await host.submission()
  expect(host.submitted[0]).toMatch(/job #r1 done: ask "Think long"/)
  expect(String((await call($, 'jobs')).result)).toMatch(/^#r1 ask done/)
})

test('another session’s job whose process is gone gets its answer back from Codex’s session files', async ($, on) => {
  const rollout = `/h/.codex/sessions/2026/11/03/rollout-2026-11-03T10-00-00-${THREAD}.jsonl`
  const host = world(on, {
    store: { 'job:r2': { ...record('r2', 'sess-0'), threadId: THREAD } },
    commands: {
      'ps -o command= -p 4242': { exitCode: 1 },
      [`find /h/.codex/sessions /h/.codex/archived_sessions -name rollout-*-${THREAD}.jsonl*`]: { exitCode: 0, stdout: `${rollout}\n` },
    },
  })
  host.state.files.add('/tmp/t/codex/runs/r2')
  host.state.texts['/tmp/t/codex/runs/r2/events.jsonl'] = line({ type: 'thread.started', thread_id: THREAD })
  host.state.texts['/tmp/t/codex/runs/r2/pid'] = '4242\n'
  host.state.texts[rollout] = [
    line({ type: 'event_msg', payload: { type: 'user_message', message: 'Think long' } }),
    line({ timestamp: new Date(Date.now() + 1000).toISOString(), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'The recovered answer.' } }),
  ].join('')
  await started($, host.tools)

  await host.submission()
  expect(host.submitted[0]).toMatch(/job #r2 done: ask "Think long"/)
  expect(host.written.at(-1)?.text).toBe(`<!-- codex thread ${THREAD} -->\n\nThe recovered answer.\n`)
})
