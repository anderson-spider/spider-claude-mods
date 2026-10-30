import type { EngineInterface, McpToolInputs, Register } from 'claude-code'
import { OFF_TEXT, resolveAccess, type AccessIo } from './access'
import { SonarError, sonar } from './api'
import { branches } from './branches'
import { HOTSPOT_STATUSES, hotspots } from './hotspots'
import { InputError, type Ctx, type Input } from './input'
import { SEVERITIES, STATUSES, TYPES, issue, issues, rule } from './issues'
import { findProjectKey, type ProjectIo } from './project'
import { measures, qualityGate } from './quality'
import { allOf, type SchemaFor } from './schema'

type Inputs = McpToolInputs
type Tool = (ctx: Ctx, input: Input) => Promise<string>

const PROJECT = { type: 'string', description: 'Project key. Default: sonar.projectKey of the nearest sonar-project.properties.' } as const
const BRANCH = { type: 'string', description: 'Branch name. Omit it and pullRequest for the main branch.' } as const
const PULL_REQUEST = { type: 'string', description: 'Pull request key (the PR/MR number); not with branch.' } as const
const PAGE = { type: 'integer' } as const
const PAGE_SIZE = { type: 'integer', description: '20 by default, 100 at most.' } as const

const ISSUE_STATUSES = allOf<NonNullable<Inputs['mcp__sonarqube__sonarqube_issues']['statuses']>[number]>()(...STATUSES)
const ISSUE_SEVERITIES = allOf<NonNullable<Inputs['mcp__sonarqube__sonarqube_issues']['severities']>[number]>()(...SEVERITIES)
const ISSUE_TYPES = allOf<Inputs['mcp__sonarqube__sonarqube_issues']['type']>()(...TYPES)
const HOTSPOT_STATUS = allOf<Inputs['mcp__sonarqube__sonarqube_hotspots']['status']>()(...HOTSPOT_STATUSES)

/** How much of an answer reaches the model. */
const MAX_CHARS = 60_000

/** Shapes a call's output for the host: `isError` is set only when true (the host rejects `false`). */
function reply(text: string, isError = false): { result: string } | { result: string; isError: true } {
  const cut = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS} characters: page or filter for less]` : text
  return isError ? { result: cut, isError: true as const } : { result: cut }
}

/** The settings and environment that decide which url and token are used. Each name is a literal for the engine. */
function accessIo($: EngineInterface): AccessIo {
  return {
    settings: async (source) => {
      const settings = await $.settings.read({ source })
      return { pluginConfigs: settings?.pluginConfigs, env: settings?.env }
    },
    env: async () => ({
      SONARQUBE_URL: await $.env.get('SONARQUBE_URL'),
      SONARQUBE_TOKEN: await $.env.get('SONARQUBE_TOKEN'),
      SONAR_URL: await $.env.get('SONAR_URL'),
      SONAR_TOKEN: await $.env.get('SONAR_TOKEN'),
    }),
  }
}

/** The session's folders and files, where a call that names no project finds its key. */
function projectIo($: EngineInterface): ProjectIo {
  return {
    cwd: () => $.session.cwd(),
    exists: async (path) => {
      try {
        return await $.fs.exists(path)
      } catch {
        return false
      }
    },
    read: async (path) => {
      try {
        const text = await $.fs.read(path)
        return typeof text === 'string' ? text : undefined
      } catch {
        return undefined
      }
    },
  }
}

/** The host wiring every tool shares: resolves the url and token, then runs the tool against the API. */
async function run($: EngineInterface, tool: Tool, input: Input, options: { url?: unknown; token?: unknown }): Promise<ReturnType<typeof reply>> {
  const access = await resolveAccess(accessIo($), options)
  if (access.off !== undefined) return reply(OFF_TEXT[access.off], true)
  const ctx: Ctx = {
    // $.http.fetch is wrapped, not passed as a value: the engine's validate rejects the latter.
    sonar: sonar((url, init) => $.http.fetch(url, init), access.base, access.token),
    detect: () => findProjectKey(projectIo($)),
  }
  try {
    return reply(await tool(ctx, input))
  } catch (error) {
    if (error instanceof InputError || error instanceof SonarError) return reply(error.message, true)
    throw error
  }
}

/** A hook that threw (a bug, not an API answer) still ends the call with an error instead of leaving it unanswered. */
const failed = () => reply('The sonarqube tool failed before it could answer. Try again; if it repeats, run claude --debug.', true)

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'sonarqube_quality_gate',
      description:
        'Read the SonarQube quality gate of a project, branch or pull request: its status and every condition with actual value and threshold. ' +
        'Call it first when an analysis failed, then sonarqube_measures and sonarqube_issues for the same scope.',
      inputSchema: {
        type: 'object',
        properties: { projectKey: PROJECT, branch: BRANCH, pullRequest: PULL_REQUEST },
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_quality_gate']>,
    })
    await $.tool.register({
      name: 'sonarqube_measures',
      description:
        'Read SonarQube metrics of a project, branch or pull request; a new-code period value takes precedence. Metrics with no value are listed in noValue.',
      inputSchema: {
        type: 'object',
        properties: {
          metricKeys: { type: 'array', items: { type: 'string' }, description: '1 to 20 keys, such as new_coverage, new_bugs, coverage.' },
          projectKey: PROJECT,
          branch: BRANCH,
          pullRequest: PULL_REQUEST,
        },
        required: ['metricKeys'],
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_measures']>,
    })
    await $.tool.register({
      name: 'sonarqube_issues',
      description: 'List SonarQube issues of a project, branch or pull request, paged: open ones (OPEN, CONFIRMED, REOPENED) unless statuses says otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          projectKey: PROJECT,
          branch: BRANCH,
          pullRequest: PULL_REQUEST,
          statuses: { type: 'array', items: { type: 'string', enum: ISSUE_STATUSES } },
          severities: { type: 'array', items: { type: 'string', enum: ISSUE_SEVERITIES } },
          type: { type: 'string', enum: ISSUE_TYPES },
          page: PAGE,
          pageSize: PAGE_SIZE,
        },
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_issues']>,
    })
    await $.tool.register({
      name: 'sonarqube_issue',
      description:
        'Read one open SonarQube issue by key; null when it is resolved, closed or absent. For an issue of a branch or pull request, pass that scope.',
      inputSchema: {
        type: 'object',
        properties: { issueKey: { type: 'string' }, projectKey: PROJECT, branch: BRANCH, pullRequest: PULL_REQUEST },
        required: ['issueKey'],
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_issue']>,
    })
    await $.tool.register({
      name: 'sonarqube_rule',
      description: "Read a SonarQube rule (an issue's rule, such as kotlin:S3776): name, type, severity and its description with how to fix it, as text.",
      inputSchema: {
        type: 'object',
        properties: { ruleKey: { type: 'string' } },
        required: ['ruleKey'],
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_rule']>,
    })
    await $.tool.register({
      name: 'sonarqube_hotspots',
      description: 'List SonarQube security hotspots of a project, branch or pull request, paged: those TO_REVIEW unless status is REVIEWED.',
      inputSchema: {
        type: 'object',
        properties: {
          projectKey: PROJECT,
          branch: BRANCH,
          pullRequest: PULL_REQUEST,
          status: { type: 'string', enum: HOTSPOT_STATUS },
          page: PAGE,
          pageSize: PAGE_SIZE,
        },
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_hotspots']>,
    })
    await $.tool.register({
      name: 'sonarqube_branches',
      description:
        "List a SonarQube project's analyzed branches and pull requests with each one's gate, newest first (30 of each). " +
        'Pass branch to find the pull request key of a source branch.',
      inputSchema: {
        type: 'object',
        properties: { projectKey: PROJECT, branch: { type: 'string', description: 'Keep only this branch and pull requests from it.' } },
      } satisfies SchemaFor<Inputs['mcp__sonarqube__sonarqube_branches']>,
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_quality_gate' }, async ($, e) => run($, qualityGate, e as Input, options)).catch(failed)
  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_measures' }, async ($, e) => run($, measures, e as Input, options)).catch(failed)
  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_issues' }, async ($, e) => run($, issues, e as Input, options)).catch(failed)
  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_issue' }, async ($, e) => run($, issue, e as Input, options)).catch(failed)
  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_rule' }, async ($, e) => run($, rule, e as Input, options)).catch(failed)
  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_hotspots' }, async ($, e) => run($, hotspots, e as Input, options)).catch(failed)
  on('tool.call', { tool: 'mcp__sonarqube__sonarqube_branches' }, async ($, e) => run($, branches, e as Input, options)).catch(failed)
}
