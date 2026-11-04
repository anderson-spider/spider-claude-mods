// sonarqube_quality_gate and sonarqube_measures: the gate of one analysis and the metrics behind it.
import { type Ctx, type Input, InputError, arrayOf, isObject, json, list, paging, projectKey, scope, text } from './input'

export const METRIC_KEYS_MAX = 20

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Every condition of the gate, with its actual and threshold values. */
export async function qualityGate(ctx: Ctx, input: Input): Promise<string> {
  const where = scope(input)
  const key = await projectKey(ctx, input)
  const data = await ctx.sonar('qualityGate', { projectKey: key, ...where })
  const status = isObject(data) && isObject(data.projectStatus) ? data.projectStatus : {}
  return json({
    projectKey: key,
    ...where,
    status: str(status.status),
    ignoredConditions: status.ignoredConditions === true,
    conditions: arrayOf(status, 'conditions').filter(isObject).map((c) => ({
      status: str(c.status),
      metricKey: str(c.metricKey),
      comparator: str(c.comparator),
      errorThreshold: str(c.errorThreshold),
      actualValue: str(c.actualValue),
    })),
  })
}

/** One measure: its new-code period value when it has one, else its overall value. */
function measureOf(m: Record<string, unknown>) {
  const period = isObject(m.period) ? m.period : {}
  const bestValue = period.bestValue ?? m.bestValue
  return { metric: str(m.metric), value: str(period.value) ?? str(m.value), ...(typeof bestValue === 'boolean' ? { bestValue } : {}) }
}

function metricKeysOf(input: Input): string[] {
  const metricKeys = list(input, 'metricKeys')
  if (!metricKeys) throw new InputError('metricKeys is required: one to 20 metric keys, such as new_coverage or bugs.')
  if (metricKeys.length > METRIC_KEYS_MAX) throw new InputError(`metricKeys takes at most ${METRIC_KEYS_MAX} keys.`)
  return metricKeys
}

/** The asked metrics; a new-code period value takes precedence over the overall one. */
export async function measures(ctx: Ctx, input: Input): Promise<string> {
  const metricKeys = metricKeysOf(input)
  const where = scope(input)
  const key = await projectKey(ctx, input)
  const data = await ctx.sonar('measures', { component: key, metricKeys: metricKeys.join(','), ...where })
  const component = isObject(data) && isObject(data.component) ? data.component : {}
  const found = arrayOf(component, 'measures').filter(isObject).map(measureOf)
  const missing = metricKeys.filter((metric) => !found.some((m) => m.metric === metric))
  return json({ projectKey: str(component.key) ?? key, name: str(component.name), ...where, measures: found, ...(missing.length ? { noValue: missing } : {}) })
}

/** The asked metrics per file of the analysis, paged; `sortMetric` orders them and keeps only files with a value for it. */
export async function fileMeasures(ctx: Ctx, input: Input): Promise<string> {
  const metricKeys = metricKeysOf(input)
  const page = paging(input)
  const where = scope(input)
  const q = text(input, 'q')
  const sortMetric = text(input, 'sortMetric')
  if (input.descending !== undefined && typeof input.descending !== 'boolean') throw new InputError('descending must be true or false.')
  const key = await projectKey(ctx, input)
  const data = await ctx.sonar('measuresTree', {
    component: key,
    metricKeys: metricKeys.join(','),
    qualifiers: 'FIL',
    strategy: 'all',
    ...page,
    ...where,
    q,
    ...(sortMetric ? { s: 'metric', metricSort: sortMetric, metricSortFilter: 'withMeasuresOnly', asc: input.descending === true ? 'false' : 'true' } : {}),
  })
  const paged = isObject(data) && isObject(data.paging) ? data.paging : {}
  return json({
    projectKey: key,
    ...where,
    total: typeof paged.total === 'number' ? paged.total : 0,
    page: typeof paged.pageIndex === 'number' ? paged.pageIndex : page.p,
    pageSize: typeof paged.pageSize === 'number' ? paged.pageSize : page.ps,
    files: arrayOf(data, 'components').filter(isObject).map((c) => ({
      path: str(c.path) ?? str(c.name),
      measures: Object.fromEntries(arrayOf(c, 'measures').filter(isObject).map(measureOf).map((m) => [m.metric, m.value])),
    })),
  })
}
