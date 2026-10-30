// The host fake the plugin's tests share: records registered tools and answers settings, environment, files and the
// SonarQube API.
import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

export type Tool = { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }>; required?: string[] } }
export type Sent = { url: string; method?: string; headers?: Record<string, string> }
type Settings = Record<string, unknown>
type Answer = { status?: number; text: string }

/** The MCP name the host gives a tool this plugin registers. */
export const id = (name: string) => `mcp__sonarqube__${name}`

export const BASE = 'https://sonar.example.com'
export const TOKEN = 'squ_test-token'
/** The Basic credentials SonarQube 9.x takes: the token as the user, an empty password. */
export const AUTH = `Basic ${btoa(`${TOKEN}:`)}`

/**
 * A host whose environment is `env`, whose settings are `user`, `project` and `local`, whose files are `files`, whose
 * session runs in `cwd` (with `.git` in each folder of `repos`), and whose network answers `api[url]` (or `{}` with 200 for any other URL).
 * Everything is mutable through `host` between calls.
 */
export function world(
  on: On,
  opts: { env?: Record<string, string>; user?: Settings; project?: Settings; local?: Settings; files?: Record<string, string>; cwd?: string; repos?: string[]; api?: Record<string, Answer> } = {},
) {
  const tools: Tool[] = []
  const sent: Sent[] = []
  const host = { env: {}, files: {}, cwd: '/proj', repos: ['/proj'], api: {}, ...opts, settingsFail: false, fetchError: undefined as string | undefined }

  on('tool.register', (_$, e) => (tools.push(e as unknown as Tool), { value: { tool: id(e.name) } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: host.cwd }) as never)
  on('env.get', (_$, e) => ({ value: (host.env as Record<string, string>)[e.name] }) as never)
  on('settings.read', (_$, e) => {
    if (host.settingsFail) throw new Error('settings unreadable')
    return { value: (e.source === 'user' ? host.user : e.source === 'project' ? host.project : e.source === 'local' ? host.local : undefined) ?? {} } as never
  })
  on('fs.exists', (_$, e) => ({ value: host.repos.some((repo) => e.path === `${repo}/.git`) }) as never)
  on('fs.read', (_$, e) => {
    const text = (host.files as Record<string, string>)[e.path]
    if (text === undefined) throw new Error(`no file ${e.path}`)
    return { value: text } as never
  })
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers })
    if (host.fetchError) throw new Error(host.fetchError)
    const answer = (host.api as Record<string, Answer>)[e.url]
    const status = answer?.status ?? 200
    return { value: { status, ok: status < 400, headers: {}, text: answer?.text ?? '{}' } }
  })

  return { tools, sent, host }
}

/** Starts the session, so the plugin registers its tools, and returns their names. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }, tools: Tool[]): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}
