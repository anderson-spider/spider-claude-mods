import { expect, test } from 'claude-code/testing'
import { AUTH, BASE, TOKEN, id, started, world } from './host'

const TOOLS = [
  'sonarqube_quality_gate',
  'sonarqube_measures',
  'sonarqube_issues',
  'sonarqube_issue',
  'sonarqube_rule',
  'sonarqube_hotspots',
  'sonarqube_branches',
]

/** The plugin's options with both set: what a user stores in their plugin options. */
const ON = { options: { url: BASE, token: TOKEN } }
const GATE_URL = `${BASE}/api/qualitygates/project_status?projectKey=app`
const GATE = { text: JSON.stringify({ projectStatus: { status: 'OK', conditions: [] } }) }

const text = (result: { result?: unknown }) => String(result.result)

test('session start registers the seven read-only tools and no other', ON, async ($, on) => {
  const { tools } = world(on)

  expect((await started($, tools)).sort()).toEqual([...TOOLS].sort())
})

/** Sums every description string (tool and schema properties) in a registered tool. */
function descriptionChars(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, v) => n + descriptionChars(v), 0)
  if (node === null || typeof node !== 'object') return 0
  return Object.entries(node).reduce((n, [k, v]) => n + (k === 'description' && typeof v === 'string' ? v.length : descriptionChars(v)), 0)
}

// every tool's descriptions ride in each request's prompt, so the budget is per tool
const TOOL_BUDGET = 650

test('each tool keeps its tool and schema descriptions within the prompt budget', ON, async ($, on) => {
  const { tools } = world(on)
  await started($, tools)

  for (const tool of tools) expect(descriptionChars(tool), tool.name).toBeLessThanOrEqual(TOOL_BUDGET)
})

test('the token goes only in the Authorization header of a GET to the url option', ON, async ($, on) => {
  const { tools, sent } = world(on, { api: { [GATE_URL]: GATE } })
  await started($, tools)

  const result = await $.tool.call({ tool: id('sonarqube_quality_gate'), projectKey: 'app' } as never)

  expect(sent).toEqual([{ url: GATE_URL, method: 'GET', headers: { Authorization: AUTH, Accept: 'application/json' } }])
  expect(JSON.parse(text(result))).toEqual({ projectKey: 'app', status: 'OK', ignoredConditions: false, conditions: [] })
  expect(text(result)).not.toContain(TOKEN)
})

test('without the options, the SONAR_URL and SONAR_TOKEN environment variables are used', async ($, on) => {
  const { tools, sent } = world(on, { env: { SONAR_URL: BASE, SONAR_TOKEN: TOKEN }, api: { [GATE_URL]: GATE } })
  await started($, tools)

  await $.tool.call({ tool: id('sonarqube_quality_gate'), projectKey: 'app' } as never)

  expect(sent.map((s) => [s.url, s.headers?.Authorization])).toEqual([[GATE_URL, AUTH]])
})

test('with no url and token, or a url the repository set in env, nothing is sent and the answer says where to set them', async ($, on) => {
  const { tools, sent, host } = world(on)
  await started($, tools)

  const none = await $.tool.call({ tool: id('sonarqube_quality_gate'), projectKey: 'app' } as never)
  expect(none.isError).toBe(true)
  expect(text(none)).toContain('export SONARQUBE_URL and SONARQUBE_TOKEN')

  host.env = { SONAR_URL: 'https://evil.example.com', SONAR_TOKEN: TOKEN }
  host.project = { env: { SONAR_URL: 'https://evil.example.com' } }
  const chosen = await $.tool.call({ tool: id('sonarqube_quality_gate'), projectKey: 'app' } as never)
  expect(chosen.isError).toBe(true)
  expect(text(chosen)).toContain('repository settings set the SonarQube url or token environment variable')
  expect(text(chosen)).not.toContain('evil')

  expect(sent).toEqual([])
})

test('a call with no projectKey reads sonar-project.properties from the session folder up to its git root', ON, async ($, on) => {
  const { tools, sent } = world(on, { cwd: '/proj/app', files: { '/proj/sonar-project.properties': 'sonar.projectKey=app\n' }, api: { [GATE_URL]: GATE } })
  await started($, tools)

  const result = await $.tool.call({ tool: id('sonarqube_quality_gate') } as never)

  expect(sent.map((s) => s.url)).toEqual([GATE_URL])
  expect(JSON.parse(text(result)).projectKey).toBe('app')
})

test('input errors and API errors answer as errors', ON, async ($, on) => {
  const { tools, sent, host } = world(on)
  await started($, tools)

  const input = await $.tool.call({ tool: id('sonarqube_issues'), projectKey: 'app', branch: 'a', pullRequest: '1' } as never)
  expect(input.isError).toBe(true)
  expect(text(input)).toContain('mutually exclusive')
  expect(sent).toEqual([])

  host.api = { [GATE_URL]: { status: 401, text: '' } }
  const refused = await $.tool.call({ tool: id('sonarqube_quality_gate'), projectKey: 'app' } as never)
  expect(refused.isError).toBe(true)
  expect(text(refused)).toContain('refused the token (HTTP 401)')
})

test('an answer past 60,000 characters is cut, saying how to get less', ON, async ($, on) => {
  const url = `${BASE}/api/issues/search?componentKeys=app&p=1&ps=100&statuses=OPEN%2CCONFIRMED%2CREOPENED`
  const issue = { key: 'K', rule: 'r', severity: 'MAJOR', type: 'BUG', status: 'OPEN', component: 'c', message: 'm'.repeat(1_000) }
  const { tools } = world(on, { api: { [url]: { text: JSON.stringify({ total: 100, p: 1, ps: 100, issues: Array.from({ length: 100 }, () => issue) }) } } })
  await started($, tools)

  const result = await $.tool.call({ tool: id('sonarqube_issues'), projectKey: 'app', pageSize: 100 } as never)

  expect(text(result).length).toBeLessThan(60_100)
  expect(text(result)).toContain('[cut at 60000 characters: page or filter for less]')
})
