import { expect, test } from 'claude-code/testing'
import { NO_EDIT } from '../hooks/args'
import { ROOT_CHECK } from '../hooks/detached'
import { REVIEW_USAGE } from '../hooks/tool-schemas'
import { CONVERSATION, agyError, answered, failed, init } from './fakes'
import { id, started, world } from './host'

const call = ($: { tool: { call: (input: never) => Promise<unknown> } }, tool: string, input: Record<string, unknown> = {}) =>
  $.tool.call({ tool: id(tool), ...input } as never) as Promise<{ result?: unknown; isError?: boolean }>

const command = ($: { command: { run: (input: never) => Promise<unknown> } }, name: string, args = '') =>
  $.command.run({ command: name, args } as never) as Promise<{ text?: string; context?: string[] }>

test('session start registers the ask, review and jobs tools and the three commands', async ($, on) => {
  const { tools, commands } = world(on)

  expect(await started($, tools)).toEqual(['ask', 'review', 'jobs'])
  expect(commands).toEqual(['agy-ask', 'agy-review', 'agy-doctor'])
  expect(Object.keys(tools[0]!.inputSchema.properties)).toEqual(['prompt', 'conversationId', 'model', 'effort', 'files', 'wait', 'out', 'maxChars'])
  expect(Object.keys(tools[1]!.inputSchema.properties)).toEqual(['base', 'commit', 'focus', 'model', 'effort', 'wait', 'out', 'maxChars'])
})

test('an ask runs agy sandboxed in the session folder, never skipping permissions, saves the answer and returns it', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('Looks fine.') }] })
  await started($, host.tools)

  const result = await call($, 'ask', { prompt: 'Review the plan', effort: 'low', model: 'gemini-4-argon-high', files: ['/proj/plan.md', '/etc/app/conf.yml'] })

  expect(result.isError).toBe(undefined)
  expect(host.launched).toEqual([
    {
      cwd: '/proj',
      argv: [
        '/h/.local/bin/agy',
        '--output-format=stream-json',
        '--disable-slash-commands',
        '--sandbox',
        '--print-timeout=1770s',
        '--model=gemini-4-argon-high',
        '--effort=low',
        '--add-dir=/etc/app',
        `--print=Review the plan\n\nFiles to read (absolute paths):\n- /proj/plan.md\n- /etc/app/conf.yml\n\n${NO_EDIT}`,
      ],
    },
  ])
  expect(host.launched[0]!.argv.join(' ')).not.toMatch(/dangerously/)
  expect(host.written[0]?.path).toMatch(/^\/tmp\/t\/agy\/\d{8}-\d{6}-review-the-plan\.md$/)
  expect(host.written[0]?.text).toBe(`<!-- agy conversation ${CONVERSATION} · model gemini-4-argon-high -->\n\nNot a git repository: edits by agy could not be checked.\n\nLooks fine.\n`)
  expect(String(result.result)).toMatch(new RegExp(`^agy's answer \\(unverified; check facts before using them\\) saved to /tmp/t/agy/.*\\nConversation: ${CONVERSATION}\\n\\nNot a git repository.*\\n\\nLooks fine\\.$`))
  expect(host.statuses).toEqual(['agy is working', undefined])
})

const INSIDE = { '-C /proj rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true\n' } }

test('an ask in a git repository notes nothing when the working tree stayed the same, and warns when it changed', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('Same.') }, { stdout: answered('Edited.') }], git: INSIDE, fingerprints: ['t1', 't1', 't1', 't2'] })
  await started($, host.tools)

  expect(String((await call($, 'ask', { prompt: 'One' })).result)).toMatch(/\n\nSame\.$/)
  expect(host.written[0]?.text).toBe(`<!-- agy conversation ${CONVERSATION} · model gemini-4-argon-medium -->\n\nSame.\n`)

  const changed = await call($, 'ask', { prompt: 'Two' })
  expect(String(changed.result)).toMatch(/\n\nWarning: the working tree changed during this run \(agy was told not to edit\); check `git status` and `git diff`\.\n\nEdited\.$/)
})

test('a failed run says why in the closed set of reasons, and never shows the Google Cloud project or region', async ($, on) => {
  const host = world(on, {
    agy: [
      { stdout: failed('Quota exhausted for projects/acme-prod-42/locations/us-central1'), stderr: agyError('RESOURCE_EXHAUSTED', 'quota for acme-prod-42 in us-central1'), code: 3 },
      { stdout: '', stderr: 'error: invalid flag --bogus\n', code: 1 },
      { stdout: failed('the print timeout expired', 'print_timeout'), code: 3 },
      { stdout: init(), stderr: agyError('UNAVAILABLE', 'backend down for acme-prod-42'), code: 3 },
    ],
  })
  await started($, host.tools)

  const quota = await call($, 'ask', { prompt: 'One' })
  expect(quota.isError).toBe(true)
  expect(String(quota.result)).toMatch(/^agy failed \(quota exhausted\): Quota exhausted for projects\/…\/locations\/…\n/)
  expect(String(quota.result)).toMatch(/Run \/agy-doctor to check the agy CLI, its sign-in and its quota\.$/)
  expect(String((await call($, 'ask', { prompt: 'Two' })).result)).toMatch(/^agy failed \(local error\): error: invalid flag --bogus\n/)
  expect(String((await call($, 'ask', { prompt: 'Three' })).result)).toMatch(/^agy failed \(timed out\): the print timeout expired\n/)
  const api = String((await call($, 'ask', { prompt: 'Four' })).result)
  expect(api).toMatch(/^agy failed \(agy error\): UNAVAILABLE \(error id e-123\)\n/)
  for (const text of [quota.result, api].map(String)) expect(text).not.toMatch(/acme-prod-42|us-central1/)
  expect(host.written).toEqual([])
})

const REPO = {
  ...INSIDE,
  '-C /proj symbolic-ref --quiet --short refs/remotes/origin/HEAD': { exitCode: 0, stdout: 'origin/main\n' },
  '-C /proj ls-files --others --exclude-standard': { exitCode: 0, stdout: 'new.ts\nsrc/b.ts\n' },
  '-C /proj diff --name-only origin/main...HEAD': { exitCode: 0, stdout: 'src/a.ts\nsrc/b.test.ts\n' },
  '-C /proj worktree add --detach <wt> HEAD': { exitCode: 0 },
  '-C <wt> rev-parse --is-inside-work-tree': { exitCode: 0, stdout: 'true\n' },
  '-C /proj worktree remove --force <wt>': { exitCode: 0 },
  '-C /proj worktree prune': { exitCode: 0 },
}

test('a review without a target covers the branch against origin/HEAD in a throwaway worktree holding the diff, then removes it', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('[P1] Off by one — src/a.ts:3') }], git: REPO, fingerprints: ['w1', 'w1'] })
  await started($, host.tools)

  const result = await call($, 'review', { focus: 'the retry loop' })

  expect(result.isError).toBe(undefined)
  const { argv, cwd } = host.launched[0]!
  expect(cwd).toMatch(/^\/tmp\/t\/agy\/worktrees\/\w+$/)
  expect(host.processes.map(p => p.argv)).toContainEqual(['sh', '-c', 'umask 077; git -C "$1" -c core.fsmonitor=false diff --no-ext-diff --no-textconv "$2" >"$3"', 'sh', '/proj', 'origin/main...HEAD', `${cwd}/.agy-review.diff`])
  const prompt = argv.at(-1)!
  expect(prompt).toMatch(new RegExp(`^--print=Review the code changes of this git repository \\(review against origin/main\\)\\. The full diff is in ${cwd}/\\.agy-review\\.diff; the changed files are:\\n- src/a\\.ts\\n- src/b\\.test\\.ts\\n`))
  expect(prompt).toMatch(/\[P0\|P1\|P2\|P3\] short title — path:line/)
  expect(prompt).toMatch(/If you find nothing, say "No findings\." and stop/)
  expect(prompt).toMatch(/\n\nAlso look closely at: the retry loop\n\nDo not edit, create or delete any file/)
  expect(host.processes.map(p => p.argv.join(' '))).toContain(`git -C /proj worktree remove --force ${cwd}`)
  expect(host.written[0]?.path).toMatch(/^\/tmp\/t\/agy\/\d{8}-\d{6}-review-against-origin-main\.md$/)
  expect(host.written[0]?.text).toBe(
    `<!-- agy conversation ${CONVERSATION} · model gemini-4-argon-medium · review against origin/main -->\n\n2 untracked files were not reviewed; commit them to include them.\n\n[P1] Off by one — src/a.ts:3\n`,
  )
})

test('a review that finds its worktree edited says so; one with nothing to diff starts no run', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('No findings.') }], git: { ...REPO }, fingerprints: ['w1', 'w2'] })
  await started($, host.tools)

  expect(String((await call($, 'review')).result)).toMatch(/Warning: agy edited its review worktree, against its instructions; the worktree was removed and your checkout was not touched\.\n\nNo findings\.$/)

  host.state.git['-C /proj diff --name-only origin/main...HEAD'] = { exitCode: 0, stdout: '' }
  const empty = await call($, 'review')
  expect(empty).toMatchObject({ isError: true, result: 'Nothing to review: origin/main...HEAD changes no file.' })
  expect(host.launched).toHaveLength(1)
})

test('a review outside a git repository is refused before agy runs', async ($, on) => {
  const host = world(on)
  await started($, host.tools)

  expect(await call($, 'review')).toEqual({ result: 'Not a git repository: a review needs the session to run inside one.', isError: true })
  host.state.gitFails = true
  expect(String((await call($, 'review')).result)).toBe('git could not run (antigravity: $.process.run: ENOENT: git), so the review did not start.')
  expect(host.launched).toEqual([])
})

test('without origin/HEAD the review falls back to main, else master, else asks for a base', async ($, on) => {
  const verify = (branch: string) => `-C /proj rev-parse --verify --quiet refs/heads/${branch}`
  const { '-C /proj symbolic-ref --quiet --short refs/remotes/origin/HEAD': _, ...repo } = REPO
  const host = world(on, {
    agy: [{ stdout: answered('Fine.') }, { stdout: answered('Fine.') }],
    git: { ...repo, [verify('main')]: { exitCode: 0 }, '-C /proj diff --name-only main...HEAD': { exitCode: 0, stdout: 'a\n' }, '-C /proj diff --name-only master...HEAD': { exitCode: 0, stdout: 'a\n' } },
  })
  await started($, host.tools)

  await call($, 'review')
  expect(host.launched[0]!.argv.at(-1)).toMatch(/\(review against main\)/)

  delete host.state.git[verify('main')]
  host.state.git[verify('master')] = { exitCode: 0 }
  await call($, 'review')
  expect(host.launched[1]!.argv.at(-1)).toMatch(/\(review against master\)/)

  delete host.state.git[verify('master')]
  expect(String((await call($, 'review')).result)).toBe('No default branch found (origin/HEAD, main or master): pass the base to review against.')
  expect(host.launched).toHaveLength(2)
})

test('/agy-review takes one target and a focus, says it was a review, and refuses what it cannot read', async ($, on) => {
  const host = world(on, {
    agy: [{ stdout: answered('Fine.') }, { stdout: answered('Fine.') }],
    git: { ...REPO, '-C /proj diff --name-only abc1234^!': { exitCode: 0, stdout: 'a\n' }, '-C /proj worktree add --detach <wt> abc1234': { exitCode: 0 } },
  })
  await started($, host.tools)

  const shown = await command($, 'agy-review', '--commit abc1234 focus on the parser')
  expect(host.launched[0]!.argv.at(-1)).toMatch(/\(review of commit abc1234\)[\s\S]*Also look closely at: focus on the parser/)
  expect(shown.text).toMatch(/^Fine\.\n\n— agy, conversation /)
  expect(shown.context?.[0]).toMatch(/^The user asked agy for a review through \/agy-review; it is saved to /)

  await command($, 'agy-review', 'only the runner')
  expect(host.launched[1]!.argv.at(-1)).toMatch(/\(review against origin\/main\)[\s\S]*Also look closely at: only the runner/)

  for (const args of ['--base', '--commit --base', '--uncommitted', '--bogus x']) expect((await command($, 'agy-review', args)).text).toBe(REVIEW_USAGE)
  expect(host.launched).toHaveLength(2)
})

test('an ask refuses a file whose folder would open the home folder or above, and an out outside the project and the answers folder', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('Saved.') }, { stdout: answered('Saved.') }] })
  await started($, host.tools)

  const wide = (path: string, dir: string) => `${path} is in ${dir}, and agy would get that whole folder; copy the file into a narrower folder first.`
  expect((await call($, 'ask', { prompt: 'Hi', files: ['/h/notes.md'] })).result).toBe(wide('/h/notes.md', '/h'))
  expect((await call($, 'ask', { prompt: 'Hi', files: ['/hosts'] })).result).toBe(wide('/hosts', '/'))
  expect((await call($, 'ask', { prompt: 'Hi', files: ['/proj/../h/.ssh/id_ed25519'] })).result).toBe('/proj/../h/.ssh/id_ed25519 must be an absolute path without . or .. parts.')
  for (const out of ['/h/.zshrc', '/h/.ssh/authorized_keys', '/tmp/t/agy-other/a.md']) {
    expect(await call($, 'ask', { prompt: 'Hi', out })).toEqual({ result: `${out} is outside the project and /tmp/t/agy; save the answer in one of them.`, isError: true })
  }
  expect((await call($, 'ask', { prompt: 'Hi', out: '/proj/../h/.zshrc' })).result).toBe('/proj/../h/.zshrc must be an absolute path without . or .. parts.')
  expect((await call($, 'ask', { prompt: 'Hi', out: '/proj/.git/hooks/pre-commit' })).result).toBe('/proj/.git/hooks/pre-commit is inside a .git folder; save the answer elsewhere.')
  expect(host.launched).toEqual([])

  await call($, 'ask', { prompt: 'Hi', out: '/proj/docs/agy.md' })
  await call($, 'ask', { prompt: 'Hi', out: '/tmp/t/agy/mine.md' })
  expect(host.written.map(w => w.path)).toEqual(['/proj/docs/agy.md', '/tmp/t/agy/mine.md'])
})

test('without TMPDIR the plugin works under a folder of the user’s own, made private before a run', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('Fine.') }] })
  host.state.env.TMPDIR = undefined
  host.state.commands['id -u'] = { exitCode: 0, stdout: '501\n' }
  await started($, host.tools)

  await call($, 'ask', { prompt: 'Hi' })

  expect(host.processes.map(p => p.argv)).toContainEqual(['sh', '-c', ROOT_CHECK, 'sh', '/tmp/agy-501'])
  expect(host.written[0]?.path).toMatch(/^\/tmp\/agy-501\/\d{8}-\d{6}-hi\.md$/)
})

test('a plugin folder the user does not own alone stops the run before agy starts', async ($, on) => {
  const host = world(on)
  host.state.commands[`sh -c ${ROOT_CHECK} sh /tmp/t/agy`] = { exitCode: 1 }
  await started($, host.tools)

  expect(await call($, 'ask', { prompt: 'Hi' })).toEqual({
    result: '/tmp/t/agy is not a private folder of yours (a symlink, or another user owns it), so agy did not run. Remove it or set TMPDIR.',
    isError: true,
  })
  expect((await command($, 'agy-ask', 'Hi')).text).toMatch(/^\/tmp\/t\/agy is not a private folder of yours/)
  expect(host.launched).toEqual([])
})

test('a model agy models does not list is refused with the valid ids before anything runs, and bad inputs are answered', async ($, on) => {
  const host = world(on)
  await started($, host.tools)

  expect(await call($, 'ask', { prompt: 'Hi', model: 'Gemini 4 Argon (High)' })).toEqual({ result: 'Gemini 4 Argon (High) is not a model id.', isError: true })
  expect(await call($, 'ask', { prompt: 'Hi', model: 'gemini-9' })).toEqual({
    result: 'gemini-9 is not an agy model id. agy models lists: gemini-4-argon-high, gemini-3.8-flash-low.',
    isError: true,
  })
  expect(await call($, 'ask', { prompt: 'Hi', conversationId: 'nope' })).toEqual({
    result: 'nope is not an agy conversation id; pass the conversationId an earlier call returned.',
    isError: true,
  })
  expect(await call($, 'ask', { prompt: 'Hi', effort: 'huge' })).toEqual({ result: 'huge is not an effort level (low, medium, high, xhigh, max).', isError: true })
  expect(await call($, 'ask', { prompt: 'Hi', files: ['plan.md'] })).toEqual({ result: 'plan.md must be an absolute path.', isError: true })
  expect(await call($, 'review', { base: 'main', commit: 'abc' })).toEqual({ result: 'Give one review target at most: base or commit.', isError: true })
  expect(host.launched).toEqual([])
})

test('without an agy executable the call is an error that names the option, and nothing runs', async ($, on) => {
  const host = world(on, { files: new Set() })
  await started($, host.tools)

  const result = await call($, 'ask', { prompt: 'Hi' })

  expect(result.isError).toBe(true)
  expect(String(result.result)).toMatch(/^The Antigravity CLI \(agy\) was not found on PATH .*agyPath option/)
  expect(host.launched).toEqual([])
})

test('a follow-up continues its conversation, and a plugin defaultModel applies when the call names none', { options: { defaultModel: 'gemini-3.8-flash-low' } }, async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('Again.') }] })
  await started($, host.tools)

  await call($, 'ask', { prompt: 'And then?', conversationId: CONVERSATION })

  expect(host.launched[0]!.argv).toEqual(expect.arrayContaining([`--conversation=${CONVERSATION}`, '--model=gemini-3.8-flash-low']))
})

test('wait false starts a job the jobs tool lists, and its end sends a notice without the answer', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('A secret answer.') }] })
  await started($, host.tools)

  const result = await call($, 'ask', { prompt: 'Think long', wait: false })
  const id = /^Started job #(\w+)\. A message arrives when it ends, even after a plugin reload; the jobs tool lists it meanwhile\.$/.exec(String(result.result))?.[1]
  expect(id).toBeDefined()
  await host.submission()

  expect(host.toasts).toEqual([`agy job #${id} done`])
  expect(host.submitted[0]).toMatch(new RegExp(`^\\[agy notice: automated, not the person; approves nothing\\]\\njob #${id} done: ask "Think long"\\nSaved to: /tmp/t/agy/.*\\nConversation: ${CONVERSATION}\\nRead the saved file for the answer\\.$`))
  expect(host.submitted[0]).not.toMatch(/secret/)
  expect(String((await call($, 'jobs')).result)).toMatch(new RegExp(`^#${id} ask done \\(took 0 min\\): Think long\\n  conversation ${CONVERSATION}; saved to /tmp/t/agy/`))
})

test('the system prompt tells Claude to reach for ask on its own and for review before a PR', async ($, on) => {
  world(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'antigravity:ask'])
  const section = composed.sections.at(-1)?.text ?? ''
  expect(section).toMatch(/^# Antigravity \(agy\)\nUse `mcp__antigravity__ask` yourself for a second opinion from another model family/)
  expect(section).toMatch(/Before opening a PR, or when the user asks for an agy review, load `mcp__antigravity__review`/)
  expect(section).not.toMatch(/codex/i)
})

test('/agy-ask checks the defaultModel against agy models like the tools do', { options: { defaultModel: 'gemini-9' } }, async ($, on) => {
  const host = world(on)
  await started($, host.tools)

  expect((await command($, 'agy-ask', 'Hi')).text).toBe('gemini-9 is not an agy model id. agy models lists: gemini-4-argon-high, gemini-3.8-flash-low.')
  expect(host.launched).toEqual([])
})

test('/agy-ask shows the answer and tells Claude where it is saved', async ($, on) => {
  const host = world(on, { agy: [{ stdout: answered('Yes.') }] })
  await started($, host.tools)

  const shown = await command($, 'agy-ask', 'Is it safe?')

  expect(shown.text).toMatch(new RegExp(`Yes\\.\\n\\n— agy, conversation ${CONVERSATION}\\nSaved to /tmp/t/agy/.*-is-it-safe\\.md$`))
  expect(shown.context?.[0]).toMatch(/^The user asked agy through \/agy-ask; its answer is saved to /)
  expect((await command($, 'agy-ask', '  ')).text).toBe('Usage: /agy-ask <question>')
})

test('/agy-doctor reports the executable, version, sign-in, models and quota, spending none', async ($, on) => {
  const usage = { conversation_id: '', status: 'SUCCESS', response: 'Gemini Models\tWeekly Limit Remaining\t99%\t2026-11-16T14:14:59Z\nGemini Models\tFive Hour Limit Remaining\t3%\t2026-11-09T19:14:59Z\n' }
  const host = world(on)
  host.state.runs['--version'] = { exitCode: 0, stdout: '1.5.3\n' }
  host.state.runs['--output-format=json -p=/usage'] = { exitCode: 0, stdout: JSON.stringify(usage) }
  await started($, host.tools)

  const text = (await command($, 'agy-doctor')).text

  expect(text).toBe(
    [
      '✓ agy: /h/.local/bin/agy',
      '✓ version: 1.5.3',
      '✓ sign-in and models: gemini-4-argon-high, gemini-3.8-flash-low',
      '✓ quota: Gemini Models Weekly Limit Remaining 99% (resets 2026-11-16T14:14:59Z); Gemini Models Five Hour Limit Remaining 3% (resets 2026-11-09T19:14:59Z)',
    ].join('\n'),
  )
  expect(host.processes.map(p => p.argv.join(' '))).not.toContain(expect.stringMatching(/disable-slash-commands/))

  host.state.runs['--version'] = { exitCode: 0, stdout: '1.4.9\n' }
  host.state.runs.models = { exitCode: 1, stderr: 'Error: authentication required. Run \'agy\' to log in.\n' }
  expect((await command($, 'agy-doctor')).text).toMatch(
    /✗ version: 1\.4\.9; the plugin needs agy 1\.5 or later \(agy update\)\n✗ sign-in and models: Error: authentication required\. Run 'agy' to log in\.\n.*\nSign in once by running `! agy`\.$/,
  )
})
