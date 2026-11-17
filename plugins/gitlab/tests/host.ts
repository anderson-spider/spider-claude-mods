// The fake outside world the run tests share: git, ssh, the repository's settings, the environment and the GitLab
// API, as `Deps` for `run`. `hostTest` hands each test a `$` whose `tool.call` runs a tool the way the server does, and
// an `on` that `world` fills, so a test reads as a session that calls tools.
import { run, type Deps, type Options } from '../server/run.ts'
import { SPECS, TOOLS, type ToolSpec } from '../server/tools.ts'
import { expect, test } from './expect.ts'

export type Tool = ToolSpec & { inputSchema: { properties: Record<string, { description?: string }> } }
export type Sent = { url: string; method?: string; headers?: Record<string, string>; body?: string }
type Settings = Record<string, unknown>
type Answer = { status?: number; text: string }

/** The name Claude Code gives a tool of this plugin's MCP server. */
export const PREFIX = 'mcp__plugin_gitlab_gitlab__'
export const id = (name: string) => `${PREFIX}${name}`

/** One test's session: the plugin's options, and the world `world` builds. */
export type Session = { options: Options; deps?: Deps }

type Result = { result: string; isError?: true }
export type Dollar = { tool: { call: (input: never) => Promise<Result> } }

/** `test`, with the plugin's options (`{ options }`) and a session: `$.tool.call` runs a tool through `run`. */
export function hostTest(name: string, opts: { options?: Options } | (($: Dollar, on: Session) => unknown), body?: ($: Dollar, on: Session) => unknown): void {
  const [given, fn] = typeof opts === 'function' ? [{}, opts] : [opts, body!]
  test(name, () => {
    const session: Session = { options: given.options ?? {} }
    const $: Dollar = {
      tool: {
        call: async (input: never) => {
          const { tool, ...rest } = input as { tool: string } & Record<string, unknown>
          const short = tool.startsWith(PREFIX) ? (tool.slice(PREFIX.length) as keyof typeof TOOLS) : undefined
          if (!short || !TOOLS[short]) throw new Error(`no tool ${tool}`)
          if (!session.deps) throw new Error('world() first')
          const reply = await run(session.deps, TOOLS[short], rest, session.options)
          return reply.isError ? { result: reply.text, isError: true } : { result: reply.text }
        },
      },
    }
    return fn($, session)
  })
}

/**
 * A world whose repository has `remote` as origin on `branch`, whose settings are `project` and `local`, and whose
 * network answers `api[url]` (`{ status, text }`, or a list answered in turn with the last one repeated; 404
 * otherwise). Everything is mutable through `host` between calls; `runs` records every process and wait.
 */
export function world(on: Session, opts: { remote?: string; branch?: string; project?: Settings; local?: Settings; env?: Record<string, string>; api?: Record<string, Answer | Answer[]> } = {}) {
  const tools: Tool[] = []
  const sent: Sent[] = []
  const runs: string[] = []
  const host = {
    remote: 'git@gitlab.example.com:team/app.git',
    branch: 'feature/x',
    api: {},
    env: {} as Record<string, string>,
    ...opts,
    settingsFail: false,
    fetchError: undefined as string | undefined,
    /** What `ssh -G <alias>` prints as its hostname line, per alias; ssh fails for any other. */
    ssh: {} as Record<string, string>,
  }
  const out = (exitCode: number, stdout: string) => ({ exitCode, stdout })

  on.deps = {
    git: async (args) => {
      const line = args.join(' ')
      runs.push(`git ${line}`)
      if (line === 'remote get-url origin') return host.remote ? out(0, `${host.remote}\n`) : out(2, '')
      if (line === 'remote') return out(0, '')
      if (line === 'rev-parse --abbrev-ref HEAD') return out(0, `${host.branch}\n`)
      return out(1, '')
    },
    ssh: async (args) => {
      const line = args.join(' ')
      runs.push(`ssh ${line}`)
      const alias = /^-G (\S+)$/.exec(line)?.[1]
      if (alias && host.ssh[alias]) return out(0, `user git\nhostname ${host.ssh[alias]}\nport 22\n`)
      return out(255, '')
    },
    fetch: async (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers, body: init.body })
      if (host.fetchError) throw new Error(host.fetchError)
      const listed = (host.api as Record<string, Answer | Answer[]>)[url]
      const answer = Array.isArray(listed) ? (listed.length > 1 ? listed.shift() : listed[0]) : listed
      const status = answer ? (answer.status ?? 200) : 404
      return { status, ok: status < 400, headers: {}, text: answer?.text ?? '{"message":"404 Not Found"}' }
    },
    env: async (name) => host.env[name],
    settings: async (source) => {
      if (host.settingsFail) throw new Error('settings unreadable')
      const settings = (source === 'project' ? host.project : host.local) ?? {}
      return { pluginConfigs: settings.pluginConfigs, env: settings.env }
    },
    clock: {
      now: () => 0,
      sleep: async (ms) => { runs.push(`sleep ${ms / 1000}`) },
    },
  }

  return { tools, sent, host, runs }
}

/** The tools the server lists, put in `tools`, and their names. */
export async function started(_$: Dollar, tools: Tool[]): Promise<string[]> {
  tools.push(...(SPECS as unknown as Tool[]))
  expect(tools.length).toBeGreaterThan(0)

  return tools.map((tool) => tool.name)
}
