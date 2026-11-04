import { expect, test } from 'claude-code/testing'
import { id, started, world } from './host'

const MR = id('gitlab_mr')
const WORK = 'glpat-work-123'
const PERSONAL = 'glpat-personal-456'
const ON = { options: { tokens: `gitlab.example.com=${WORK}, gitlab.com=${PERSONAL}` } }

const WORK_API = 'https://gitlab.example.com/api/v4/projects/team%2Fapp'
const PERSONAL_API = 'https://gitlab.com/api/v4/projects/anderson-spider%2Ftools'
const MR_JSON = JSON.stringify({ iid: 7, title: 't', state: 'opened', source_branch: 'feature/x', target_branch: 'main', web_url: 'u' })

/** A valid call of each tool, which a test sends once per tool. */
const CALLS: Record<string, Record<string, unknown>> = {
  gitlab_mr: { action: 'get', iid: 7 },
  gitlab_mr_comment: { action: 'list', iid: 7 },
  gitlab_pipeline: { action: 'list', iid: 7 },
  gitlab_job_log: { jobId: 2 },
  gitlab_label: { action: 'list' },
  gitlab_user: {},
}
const call = (name: string) => ({ tool: id(name), ...CALLS[name] }) as never
const text = (result: { result?: unknown }) => String(result.result)

test('session start registers the six tools, with a guarded merge and no generic API tool', ON, async ($, on) => {
  const { tools } = world(on)

  expect(await started($, tools)).toEqual(Object.keys(CALLS))
  const mr = tools.find((t) => t.name === 'gitlab_mr')!
  expect((mr.inputSchema.properties.action as { enum?: string[] }).enum).toContain('merge')
  expect(mr.description).toContain('merge (only when the user asks; iid and head sha required')
  for (const tool of tools.filter((t) => t.name !== 'gitlab_user')) expect(Object.keys(tool.inputSchema.properties), tool.name).toContain('project')
})

test('each tool keeps its tool and schema descriptions within the prompt budget', ON, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)
  const chars = (node: unknown): number =>
    Array.isArray(node)
      ? node.reduce((n: number, v) => n + chars(v), 0)
      : node && typeof node === 'object'
        ? Object.entries(node).reduce((n, [k, v]) => n + (k === 'description' && typeof v === 'string' ? v.length : chars(v)), 0)
        : 0

  for (const tool of tools) expect(chars(tool), tool.name).toBeLessThanOrEqual(900)
})

test('the remote picks the host and its own token: the work host for one repository, gitlab.com for another', ON, async ($, on) => {
  const { sent, host } = world(on, { api: { [`${WORK_API}/merge_requests/7`]: { text: MR_JSON }, [`${PERSONAL_API}/merge_requests/7`]: { text: MR_JSON } } })

  const work = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  host.remote = 'https://gitlab.com/anderson-spider/tools.git'
  const personal = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)

  expect(work.isError).toBeUndefined()
  expect(personal.isError).toBeUndefined()
  expect(sent.map((s) => [s.url, s.headers?.['PRIVATE-TOKEN']])).toEqual([
    [`${WORK_API}/merge_requests/7`, WORK],
    [`${PERSONAL_API}/merge_requests/7`, PERSONAL],
  ])
})

test('a host with no token in the option is refused by name, and nothing is sent', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  host.remote = 'git@gitlab.other.org:team/app.git'

  for (const name of await started($, tools)) {
    const result = await $.tool.call(call(name))
    expect(result.isError, name).toBe(true)
    expect(text(result), name).toBe('The gitlab tokens option has no token for gitlab.other.org. Add gitlab.other.org=<token> in the plugin options (/plugin, gitlab, configure), or in SPIDER_PLUGIN_OPTION_GITLAB_TOKENS when the option is not set.')
  }
  expect(sent).toEqual([])
})

test('without the option, outside a GitLab repository, with repository-declared tokens or unreadable settings, nothing is sent', ON, async ($, on) => {
  const { sent, tools, host } = world(on)
  const names = await started($, tools)

  host.remote = ''
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/not a git repository with a GitLab remote/)
  host.remote = 'git@gitlab.example.com:team/app.git'
  host.project = { pluginConfigs: { gitlab: { options: { tokens: `gitlab.example.com=${WORK}` } } } }
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/repository settings declare/)
  host.project = undefined
  host.settingsFail = true
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/could not be read/)

  expect(sent).toEqual([])
})

test('an unset option says where to set it', async ($, on) => {
  const { sent } = world(on)
  const result = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  expect(text(result)).toBe('The gitlab tokens option is not set. Set it in the plugin options (/plugin, gitlab, configure) as host=token pairs, or export SPIDER_PLUGIN_OPTION_GITLAB_TOKENS with the same pairs before starting Claude.')
  expect(sent).toEqual([])
})

test('without the option, SPIDER_PLUGIN_OPTION_GITLAB_TOKENS gives the token, and a repository env setting refuses it', async ($, on) => {
  const { sent, tools, host } = world(on, { api: { [`${WORK_API}/merge_requests/7`]: { text: MR_JSON } } })
  host.env = { SPIDER_PLUGIN_OPTION_GITLAB_TOKENS: `gitlab.example.com=${WORK}` }
  const names = await started($, tools)

  expect(text(await $.tool.call(call('gitlab_mr')))).toContain('"iid":7')
  expect(sent[0]?.headers?.['PRIVATE-TOKEN']).toBe(WORK)

  host.project = { env: { SPIDER_PLUGIN_OPTION_GITLAB_TOKENS: 'x' } }
  const before = sent.length
  for (const name of names) expect(text(await $.tool.call(call(name))), name).toMatch(/repository settings set SPIDER_PLUGIN_OPTION_GITLAB_TOKENS/)
  expect(sent.length).toBe(before)
})

test('API errors and failed calls are error results naming the project, and no output carries a token', ON, async ($, on) => {
  const { tools, host } = world(on, { api: { [`${WORK_API}/merge_requests/7`]: { status: 403, text: '{"message":"403 Forbidden"}' } } })
  const names = await started($, tools)
  const results: string[] = []

  const denied = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  expect(denied.isError).toBe(true)
  expect(text(denied)).toBe("GitLab answered 403 for team/app: 403 Forbidden. The token's user may have no access to team/app.")
  results.push(text(denied))
  for (const name of names) results.push(text(await $.tool.call(call(name))))
  host.fetchError = 'connection reset'
  for (const name of names) results.push(text(await $.tool.call(call(name))))

  expect(results.at(-1)).toMatch(/^Call to gitlab\.example\.com failed: /)
  for (const out of results) {
    expect(out).not.toContain(WORK)
    expect(out).not.toContain(PERSONAL)
  }
})

const OWN_MR = JSON.stringify({ iid: 7, title: 't', state: 'opened', source_branch: 'feature/x', target_branch: 'main', author: { id: 1, username: 'ann' }, web_url: 'u' })
const USER = 'https://gitlab.example.com/api/v4/user'

test('the token goes only in the PRIVATE-TOKEN header, and writes send JSON', ON, async ($, on) => {
  const { sent } = world(on, {
    api: { [USER]: { text: '{"id":1,"username":"ann"}' }, [`${WORK_API}/merge_requests/7`]: { text: OWN_MR }, [`${WORK_API}/merge_requests/7/notes`]: { text: '{"id":5}' } },
  })

  const result = await $.tool.call({ tool: id('gitlab_mr_comment'), action: 'comment', iid: 7, body: 'LGTM' } as never)

  expect(text(result)).toBe('{"note":5}')
  expect(sent.map((s) => [s.method, s.url])).toEqual([
    ['GET', `${WORK_API}/merge_requests/7`],
    ['GET', USER],
    ['POST', `${WORK_API}/merge_requests/7/notes`],
  ])
  for (const s of sent) expect(s.headers?.['PRIVATE-TOKEN']).toBe(WORK)
  expect(sent[2]).toEqual({
    url: `${WORK_API}/merge_requests/7/notes`,
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': WORK, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{"body":"LGTM"}',
  })
})

test('a refused input is an error result before any request', ON, async ($, on) => {
  const { sent } = world(on)
  const result = await $.tool.call({ tool: MR, action: 'get', iid: -3 } as never)
  expect(result.isError).toBe(true)
  expect(text(result)).toBe('iid must be a positive integer.')
  expect(sent).toEqual([])
})

test('an answer that echoes the token, error or not, reaches the model with the token masked', ON, async ($, on) => {
  world(on, {
    api: {
      [`${WORK_API}/merge_requests/7`]: { status: 401, text: JSON.stringify({ message: `invalid token ${WORK}` }) },
      [`${WORK_API}/merge_requests/7/discussions?per_page=100&page=1`]: { text: JSON.stringify([{ id: 'aa', notes: [{ id: 1, body: `pasted ${WORK}` }] }]) },
    },
  })

  const denied = text(await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never))
  const listed = text(await $.tool.call({ tool: id('gitlab_mr_comment'), action: 'list', iid: 7 } as never))

  expect(denied).toBe('GitLab answered 401 for team/app: invalid token [token]. The token for gitlab.example.com was refused (expired or revoked?). Replace it in the plugin options (/plugin, gitlab, configure).')
  expect(listed).toContain('pasted [token]')
})

test('project switches to another project on the same host with the same token, and a URL or another host is refused unsent', ON, async ($, on) => {
  const other = 'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp'
  const { sent } = world(on, { api: { [`${other}/merge_requests/3`]: { text: MR_JSON } } })

  const ok = await $.tool.call({ tool: MR, action: 'get', iid: 3, project: 'group/sub/app' } as never)
  expect(ok.isError).toBeUndefined()
  expect(sent.map((s) => [s.url, s.headers?.['PRIVATE-TOKEN']])).toEqual([[`${other}/merge_requests/3`, WORK]])

  for (const project of ['https://gitlab.com/anderson-spider/tools', 'gitlab.com:anderson-spider/tools', 'app', -7]) {
    const refused = await $.tool.call({ tool: MR, action: 'get', iid: 3, project } as never)
    expect(refused.isError, String(project)).toBe(true)
    expect(text(refused)).toBe('project must be a project path (group/project) or numeric id on gitlab.example.com, not a URL: name another GitLab with host.')
  }
  expect(sent).toHaveLength(1)
})

const GITHUB = 'git@github.com:anderson-spider/gitlab-review.git'
const LIST_47 = 'https://gitlab.example.com/api/v4/projects/47/merge_requests?state=opened&labels=In+review&order_by=updated_at&per_page=20&page=1'

test('host names a GitLab other than the remote: its own token, project by path or numeric id, and no current-branch MR', ON, async ($, on) => {
  const { sent, tools } = world(on, { remote: GITHUB, api: { [LIST_47]: { text: '[]' }, [USER]: { text: '{"id":1,"username":"ann"}' } } })
  const names = await started($, tools)

  const listed = await $.tool.call({ tool: MR, action: 'list', host: 'gitlab.example.com', project: 47, labels: ['In review'], state: 'opened' } as never)
  expect(listed.isError).toBeUndefined()
  expect(sent.map((s) => [s.url, s.headers?.['PRIVATE-TOKEN']])).toEqual([[LIST_47, WORK]])

  expect(text(await $.tool.call({ tool: id('gitlab_user'), host: 'gitlab.example.com' } as never))).toContain('ann')
  expect(text(await $.tool.call({ tool: MR, action: 'status', host: 'gitlab.example.com', project: '47' } as never))).toMatch(/iid/)
  const before = sent.length
  for (const name of names.filter((n) => n !== 'gitlab_user' && n !== 'gitlab_job_log')) {
    expect(text(await $.tool.call({ tool: id(name), ...CALLS[name], host: 'gitlab.example.com' } as never)), name).toBe("Name the project (group/project or its numeric id): the repository's remote is not on gitlab.example.com.")
  }
  expect(sent.length).toBe(before)
})

test('host is refused unsent when it is a URL or has no token, naming the host and never a token', ON, async ($, on) => {
  const { sent } = world(on, { remote: GITHUB })

  expect(text(await $.tool.call({ tool: MR, action: 'list', host: 'https://gitlab.example.com', project: 47 } as never))).toBe('host must be a GitLab host name (gitlab.example.com), not a URL.')
  const missing = text(await $.tool.call({ tool: MR, action: 'list', host: 'gitlab.other.org', project: 47 } as never))
  expect(missing).toBe('The gitlab tokens option has no token for gitlab.other.org. Add gitlab.other.org=<token> in the plugin options (/plugin, gitlab, configure), or in SPIDER_PLUGIN_OPTION_GITLAB_TOKENS when the option is not set.')
  expect(missing).not.toContain(WORK)
  expect(sent).toEqual([])
})

test('host equal to the remote keeps the remote project and the current branch MR', ON, async ($, on) => {
  const { sent } = world(on, { api: { [`${WORK_API}/merge_requests?source_branch=feature%2Fx&state=opened&per_page=100`]: { text: '[]' } } })
  const result = await $.tool.call({ tool: MR, action: 'get', host: 'gitlab.example.com' } as never)
  expect(sent[0]?.url.startsWith(`${WORK_API}/merge_requests`)).toBe(true)
  expect(text(result)).not.toMatch(/Name the project/)
})

test('host equal to the real host of an SSH alias remote keeps the remote project; an alias for another host does not', ON, async ($, on) => {
  const { sent, host } = world(on, { remote: 'git@work:team/app.git', api: { [`${WORK_API}/merge_requests?state=opened&source_branch=feature%2Fx&per_page=20`]: { text: '[]' } } })
  host.ssh.work = 'gitlab.example.com'
  expect(text(await $.tool.call({ tool: MR, action: 'get', host: 'gitlab.example.com' } as never))).toMatch(/No open merge request has feature\/x/)
  host.ssh.work = 'gitlab.other.org'
  expect(text(await $.tool.call({ tool: MR, action: 'get', host: 'gitlab.example.com' } as never))).toBe("Pass iid: the project is not the remote's, so the current branch is not used.")
  expect(sent).toHaveLength(1)
})

test('defaultHost does not replace a remote whose token is refused for another reason than a missing host', { options: { tokens: `gitlab.example.com=${WORK}`, defaultHost: 'gitlab.example.com' } }, async ($, on) => {
  const { sent, host } = world(on)
  host.project = { pluginConfigs: { gitlab: { options: { tokens: `gitlab.example.com=${WORK}` } } } }
  expect(text(await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never))).toMatch(/repository settings declare/)
  expect(sent).toEqual([])
})

test('defaultHost, from the option or SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST, serves a remote with no token; host and a GitLab remote come first', async ($, on) => {
  const { sent, host } = world(on, { remote: GITHUB, api: { [LIST_47]: { text: '[]' }, [`${WORK_API}/merge_requests/7`]: { text: MR_JSON }, [`${PERSONAL_API}/merge_requests/7`]: { text: MR_JSON } } })
  const tokens = `gitlab.example.com=${WORK}, gitlab.com=${PERSONAL}`
  host.env = { SPIDER_PLUGIN_OPTION_GITLAB_TOKENS: tokens }
  const list = { tool: MR, action: 'list', project: 47, labels: ['In review'], state: 'opened' } as never

  expect(text(await $.tool.call(list))).toMatch(/^The gitlab tokens option has no token for github\.com\./)
  host.env.SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST = 'gitlab.example.com'
  expect((await $.tool.call(list)).isError).toBeUndefined()
  host.env.SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST = 'https://gitlab.example.com'
  expect(text(await $.tool.call(list))).toBe('The gitlab defaultHost option (or SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST) is not a host name (gitlab.example.com).')
  host.env.SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST = 'gitlab.example.com'
  host.remote = 'https://gitlab.com/anderson-spider/tools.git'
  await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  host.remote = GITHUB
  await $.tool.call({ tool: MR, action: 'get', iid: 7, host: 'gitlab.com', project: 'anderson-spider/tools' } as never)

  expect(sent.map((s) => [s.url, s.headers?.['PRIVATE-TOKEN']])).toEqual([
    [LIST_47, WORK],
    [`${PERSONAL_API}/merge_requests/7`, PERSONAL],
    [`${PERSONAL_API}/merge_requests/7`, PERSONAL],
  ])
})

test('the defaultHost option comes before its environment variable', { options: { tokens: `gitlab.example.com=${WORK}, gitlab.com=${PERSONAL}`, defaultHost: 'gitlab.com' } }, async ($, on) => {
  const { sent, host } = world(on, { remote: GITHUB, api: { [`${PERSONAL_API}/merge_requests/7`]: { text: MR_JSON } } })
  host.env = { SPIDER_PLUGIN_OPTION_GITLAB_DEFAULT_HOST: 'gitlab.example.com' }
  await $.tool.call({ tool: MR, action: 'get', iid: 7, project: 'anderson-spider/tools' } as never)
  expect(sent.map((s) => s.url)).toEqual([`${PERSONAL_API}/merge_requests/7`])
})

test("an SSH alias remote uses its real host's token, found through ssh -G, and an unresolved alias says so", ON, async ($, on) => {
  const { sent, host } = world(on, { remote: 'git@work:team/app.git', api: { [`${WORK_API}/merge_requests/7`]: { text: MR_JSON } } })
  host.ssh.work = 'gitlab.example.com'

  const ok = await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never)
  expect(ok.isError).toBeUndefined()
  expect(sent.map((s) => [s.url, s.headers?.['PRIVATE-TOKEN']])).toEqual([[`${WORK_API}/merge_requests/7`, WORK]])

  host.ssh.work = 'gitlab.other.org'
  expect(text(await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never))).toBe(
    "The remote's host work is an SSH alias for gitlab.other.org. The gitlab tokens option has no token for gitlab.other.org. Add gitlab.other.org=<token> in the plugin options (/plugin, gitlab, configure), or in SPIDER_PLUGIN_OPTION_GITLAB_TOKENS when the option is not set.",
  )
  host.remote = 'git@nowhere:team/app.git'
  expect(text(await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never))).toMatch(/If nowhere is an SSH alias from ~\/\.ssh\/config, ssh -G could not resolve it/)
  host.remote = 'https://work/team/app.git'
  expect(text(await $.tool.call({ tool: MR, action: 'get', iid: 7 } as never))).toMatch(/^The gitlab tokens option has no token for work\./)
  expect(sent).toHaveLength(1)
})

test('wait sleeps through a host process between polls, so the hook spends none of its own time', ON, async ($, on) => {
  const pipelineUrl = `${WORK_API}/pipelines/90`
  const running = { text: JSON.stringify({ id: 90, status: 'running', ref: 'main', sha: 'abcdef0123', web_url: 'u' }) }
  const { runs } = world(on, {
    api: {
      [pipelineUrl]: [running, running, { text: JSON.stringify({ id: 90, status: 'success', ref: 'main', sha: 'abcdef0123', web_url: 'u' }) }],
      [`${pipelineUrl}/jobs?scope%5B%5D=failed&per_page=100`]: { text: '[]' },
      [`${pipelineUrl}/bridges?per_page=100`]: { text: '[]' },
    },
  })

  const result = await $.tool.call({ tool: id('gitlab_pipeline'), action: 'wait', pipelineId: 90 } as never)

  expect(result.isError).toBeUndefined()
  expect(JSON.parse(text(result))).toMatchObject({ pipeline: { id: 90, status: 'success' }, finished: true, failed: [], downstream: [] })
  expect(runs.filter((r) => r.startsWith('sleep'))).toEqual(['sleep 15', 'sleep 15'])
})
