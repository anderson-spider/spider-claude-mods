// sonarqube_hotspots: the security hotspots of an analysis, those to review unless asked otherwise.
import { type Ctx, type Input, arrayOf, isObject, json, oneOf, paging, projectKey, scope } from './input'

export const HOTSPOT_STATUSES = ['TO_REVIEW', 'REVIEWED'] as const

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export async function hotspots(ctx: Ctx, input: Input): Promise<string> {
  const page = paging(input)
  const where = scope(input)
  const status = oneOf(input, 'status', HOTSPOT_STATUSES) ?? 'TO_REVIEW'
  const key = await projectKey(ctx, input)
  const data = await ctx.sonar('hotspots', { projectKey: key, status, ...page, ...where })
  const paged = isObject(data) && isObject(data.paging) ? data.paging : {}
  return json({
    projectKey: key,
    ...where,
    status,
    total: typeof paged.total === 'number' ? paged.total : 0,
    page: typeof paged.pageIndex === 'number' ? paged.pageIndex : page.p,
    pageSize: typeof paged.pageSize === 'number' ? paged.pageSize : page.ps,
    hotspots: arrayOf(data, 'hotspots').filter(isObject).map((h) => ({
      key: str(h.key),
      component: str(h.component),
      ...(typeof h.line === 'number' ? { line: h.line } : {}),
      message: str(h.message),
      vulnerabilityProbability: str(h.vulnerabilityProbability),
      securityCategory: str(h.securityCategory),
      status: str(h.status),
      ...(str(h.resolution) ? { resolution: str(h.resolution) } : {}),
      ...(str(h.ruleKey) ? { rule: str(h.ruleKey) } : {}),
    })),
  })
}
