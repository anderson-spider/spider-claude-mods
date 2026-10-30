// sonarqube_quality_gate and sonarqube_measures: the gate of one analysis and the metrics behind it.
import { type Ctx, type Input, InputError, arrayOf, isObject, json, list, projectKey, scope } from './input'

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

/** The asked metrics; a new-code period value takes precedence over the overall one. */
export async function measures(ctx: Ctx, input: Input): Promise<string> {
  const metricKeys = list(input, 'metricKeys')
  if (!metricKeys) throw new InputError('metricKeys is required: one to 20 metric keys, such as new_coverage or bugs.')
  if (metricKeys.length > METRIC_KEYS_MAX) throw new InputError(`metricKeys takes at most ${METRIC_KEYS_MAX} keys.`)
  const where = scope(input)
  const key = await projectKey(ctx, input)
  const data = await ctx.sonar('measures', { component: key, metricKeys: metricKeys.join(','), ...where })
  const component = isObject(data) && isObject(data.component) ? data.component : {}
  const found = arrayOf(component, 'measures').filter(isObject).map((m) => {
    const period = isObject(m.period) ? m.period : {}
    const bestValue = period.bestValue ?? m.bestValue
    return { metric: str(m.metric), value: str(period.value) ?? str(m.value), ...(typeof bestValue === 'boolean' ? { bestValue } : {}) }
  })
  const missing = metricKeys.filter((metric) => !found.some((m) => m.metric === metric))
  return json({ projectKey: str(component.key) ?? key, name: str(component.name), ...where, measures: found, ...(missing.length ? { noValue: missing } : {}) })
}
