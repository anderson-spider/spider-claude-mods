// sonarqube_issues, sonarqube_issue and sonarqube_rule: the issues of an analysis and the rule behind one.
import { type Ctx, type Input, arrayOf, isObject, json, list, oneOf, paging, projectKey, required, scope, text } from './input'

export const STATUSES = ['OPEN', 'CONFIRMED', 'REOPENED', 'RESOLVED', 'CLOSED'] as const
export const OPEN_STATUSES = ['OPEN', 'CONFIRMED', 'REOPENED'] as const
export const SEVERITIES = ['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR', 'INFO'] as const
export const TYPES = ['BUG', 'VULNERABILITY', 'CODE_SMELL'] as const

/** How much of a rule's description an answer keeps. */
export const RULE_TEXT_MAX = 6_000

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** One issue as answered: what locating and fixing it takes, without its flows and hashes. */
export function issueOf(issue: Record<string, unknown>) {
  const range = isObject(issue.textRange) ? issue.textRange : undefined
  const tags = Array.isArray(issue.tags) ? issue.tags.filter((t) => typeof t === 'string') : []
  return {
    key: str(issue.key),
    rule: str(issue.rule),
    severity: str(issue.severity),
    type: str(issue.type),
    status: str(issue.status),
    ...(str(issue.resolution) ? { resolution: str(issue.resolution) } : {}),
    project: str(issue.project),
    component: str(issue.component),
    ...(typeof issue.line === 'number' ? { line: issue.line } : {}),
    ...(range && typeof range.endLine === 'number' && range.endLine !== issue.line ? { endLine: range.endLine } : {}),
    message: str(issue.message),
    ...(str(issue.effort) ? { effort: str(issue.effort) } : {}),
    ...(tags.length ? { tags } : {}),
    ...(str(issue.author) ? { author: str(issue.author) } : {}),
    ...(str(issue.creationDate) ? { creationDate: str(issue.creationDate) } : {}),
  }
}

/** The issues of a project's analysis, open ones unless `statuses` says otherwise. */
export async function issues(ctx: Ctx, input: Input): Promise<string> {
  const page = paging(input)
  const where = scope(input)
  const statuses = list(input, 'statuses', STATUSES) ?? [...OPEN_STATUSES]
  const severities = list(input, 'severities', SEVERITIES)
  const type = oneOf(input, 'type', TYPES)
  const key = await projectKey(ctx, input)
  const data = await ctx.sonar('issues', {
    componentKeys: key,
    ...page,
    statuses: statuses.join(','),
    severities: severities?.join(','),
    types: type,
    ...where,
  })
  const answer = isObject(data) ? data : {}
  return json({
    projectKey: key,
    ...where,
    total: typeof answer.total === 'number' ? answer.total : 0,
    page: typeof answer.p === 'number' ? answer.p : page.p,
    pageSize: typeof answer.ps === 'number' ? answer.ps : page.ps,
    issues: arrayOf(answer, 'issues').filter(isObject).map(issueOf),
  })
}

/**
 * One open issue by key, or null when it is resolved, closed or absent. An issue of a branch or pull request is found
 * only with its project, so a scope brings the project in (the input's, else the detected one).
 */
export async function issue(ctx: Ctx, input: Input): Promise<string> {
  const issueKey = required(input, 'issueKey')
  const where = scope(input)
  const component = where.branch || where.pullRequest ? await projectKey(ctx, input) : text(input, 'projectKey')
  const data = await ctx.sonar('issues', { issues: issueKey, componentKeys: component, statuses: OPEN_STATUSES.join(','), ...where })
  const found = arrayOf(data, 'issues').filter(isObject)[0]
  return json({ issue: found ? issueOf(found) : null })
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A rule's HTML description as plain text: block tags become line breaks, list items dashes, code stays as written. */
export function htmlText(html: string): string {
  return html
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/h\d|\/pre|\/ul|\/ol|\/li|\/div|\/tr)[^>]*>/gi, '\n')
    .replace(/<h\d[^>]*>/gi, '\n## ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole
      }
      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/\n- [ \t]+/g, '\n- ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A rule's name, type, severity, tags and description as text. */
export async function rule(ctx: Ctx, input: Input): Promise<string> {
  const ruleKey = required(input, 'ruleKey')
  const data = await ctx.sonar('rule', { key: ruleKey })
  const found = isObject(data) && isObject(data.rule) ? data.rule : {}
  const tags = [...(Array.isArray(found.sysTags) ? found.sysTags : []), ...(Array.isArray(found.tags) ? found.tags : [])].filter((t) => typeof t === 'string')
  const html = str(found.htmlDesc) ?? str(found.mdDesc) ?? ''
  const description = htmlText(html)
  return json({
    key: str(found.key) ?? ruleKey,
    name: str(found.name),
    type: str(found.type),
    severity: str(found.severity),
    language: str(found.langName) ?? str(found.lang),
    ...(tags.length ? { tags } : {}),
    ...(str(found.gapDescription) ? { effortPer: str(found.gapDescription) } : {}),
    description: description.length > RULE_TEXT_MAX ? `${description.slice(0, RULE_TEXT_MAX)}\n[cut]` : description,
  })
}
