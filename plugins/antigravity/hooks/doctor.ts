import type { Check, ProcessRunner } from './model'
import { errorText } from './presentation'

/** The oldest agy whose print mode the plugin was measured against: stream-json events, `AGY_ERROR` and `/usage`. */
const MINIMUM = [1, 5] as const

const SIGN_IN = 'Sign in once by running `! agy`.'

/** Whether a version such as `1.5.3` is at least the minimum. */
export function recentEnough(version: string): boolean {
  const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number)
  return major > MINIMUM[0] || (major === MINIMUM[0] && minor >= MINIMUM[1])
}

/** The quota lines of `/usage`'s response (`group, limit, remaining, reset` separated by tabs), joined in one line. */
export function quotaOf(json: string): string | undefined {
  try {
    const response = (JSON.parse(json) as { response?: unknown }).response
    if (typeof response !== 'string') return undefined
    const lines = response.split('\n').flatMap(text => {
      const [group, limit, left, reset] = text.split('\t')
      return group && limit && left ? [`${group} ${limit} ${left}${reset ? ` (resets ${reset})` : ''}`] : []
    })
    return lines.length ? lines.join('; ') : undefined
  } catch {
    return undefined
  }
}

export type DoctorDeps = {
  agy: string | { error: string }
  run: ProcessRunner
  /** The model ids `agy models` lists, or why it failed (most often a missing sign-in). */
  models(agy: string): Promise<string[] | { error: string }>
}

/**
 * What /agy-doctor checks, spending no quota: the executable, its version, the sign-in through `agy models`, and the
 * quota through `/usage`, which starts no model turn. The probe keeps slash commands on: with
 * `--disable-slash-commands` it would be a real prompt.
 */
export async function diagnose(deps: DoctorDeps): Promise<Check[]> {
  if (typeof deps.agy !== 'string') return [{ name: 'agy', ok: false, detail: deps.agy.error }]
  const agy = deps.agy
  const checks: Check[] = [{ name: 'agy', ok: true, detail: agy }]
  const run = (argv: string[]) => deps.run([agy, ...argv], { timeoutMs: 30_000 }).catch(error => ({ exitCode: -1, stdout: '', stderr: errorText(error) }))
  const version = await run(['--version'])
  const shown = (version.stdout.trim() || version.stderr.trim()).split('\n')[0] || `exit code ${version.exitCode}`
  const fresh = version.exitCode === 0 && recentEnough(shown)
  checks.push({ name: 'version', ok: fresh, detail: fresh ? shown : `${shown}; the plugin needs agy ${MINIMUM.join('.')} or later (agy update)` })
  const models = await deps.models(agy)
  checks.push(Array.isArray(models) ? { name: 'sign-in and models', ok: true, detail: models.join(', ') } : { name: 'sign-in and models', ok: false, detail: models.error })
  const usage = await run(['--output-format=json', '-p=/usage'])
  const quota = usage.exitCode === 0 ? quotaOf(usage.stdout) : undefined
  checks.push({ name: 'quota', ok: quota !== undefined, detail: quota ?? ((usage.stderr.trim() || usage.stdout.trim()).split('\n')[0] || 'agy did not report it') })
  return checks
}

export function report(checks: Check[]): string {
  const lines = checks.map(check => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
  if (checks.some(check => check.name === 'sign-in and models' && !check.ok)) lines.push(SIGN_IN)
  return lines.join('\n')
}
