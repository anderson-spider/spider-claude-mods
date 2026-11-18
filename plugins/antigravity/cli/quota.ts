// agy's quota, read from `agy -p /usage --output-format json` (it spends none: a slash command, not a prompt), and the
// gate a task passes before it starts. Measured on agy 1.5.11: groups of buckets with an id (`gemini-5h`,
// `gemini-weekly`, `gemini-argon-wtu-weekly`, `3p-5h` for the Claude and GPT models), a window (`5h` or `weekly`), a
// `remaining_fraction` and a `reset_time`.
import { agyEnv, firstLine } from './agy.ts'
import { runProcess } from './process.ts'

export interface Bucket {
  id: string
  label: string
  window: '5h' | 'weekly' | 'other'
  /** 0 to 1. */
  remaining: number
  /** ISO time the window refills, when agy gives one. */
  resetsAt?: string
}

/** A task warns at this much left and is refused at the lower one, unless forced. */
export const WARN_AT = 0.3
export const REFUSE_AT = 0.1

export function parseUsage(stdout: string): Bucket[] | { error: string } {
  let json: any
  try {
    json = JSON.parse(stdout)
  } catch {
    return { error: 'agy /usage did not answer JSON.' }
  }
  if (json?.status !== 'SUCCESS' || json?.command?.name !== 'usage') return { error: 'agy /usage did not succeed.' }
  const buckets: Bucket[] = []
  for (const group of Array.isArray(json.command.data?.groups) ? json.command.data.groups : []) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      if (typeof bucket?.id !== 'string' || bucket.disabled === true || typeof bucket.remaining_fraction !== 'number') continue
      const window = bucket.window === '5h' || bucket.window === 'weekly' ? bucket.window : 'other'
      buckets.push({
        id: bucket.id,
        label: `${String(group.name ?? '').trim() || bucket.id} · ${window === '5h' ? '5-hour' : window === 'weekly' ? 'weekly' : String(bucket.name ?? 'quota')}`,
        window,
        remaining: Math.max(0, Math.min(1, bucket.remaining_fraction)),
        ...(typeof bucket.reset_time === 'string' && Number.isFinite(Date.parse(bucket.reset_time)) ? { resetsAt: bucket.reset_time } : {}),
      })
    }
  }
  return buckets.length > 0 ? buckets : { error: 'agy /usage listed no quota.' }
}

/**
 * The buckets a model draws on: the shared Gemini ones (`gemini-5h`, `gemini-weekly`) and its family's
 * (`gemini-4-argon-high` → `gemini-argon-*`); a Claude or GPT model, the `3p-` ones. With no model, the shared Gemini ones.
 */
export function bucketsFor(buckets: Bucket[], model: string | undefined): Bucket[] {
  if (model && !model.startsWith('gemini-')) return buckets.filter(bucket => bucket.id.startsWith('3p-'))
  const family = model?.match(/^gemini-[\d.]+-([a-z]+)/)?.[1]
  const shared = (id: string) => /^gemini-(5h|weekly)$/.test(id)
  return buckets.filter(bucket => shared(bucket.id) || (family !== undefined && bucket.id.startsWith(`gemini-${family}-`)))
}

export interface Gate {
  verdict: 'ok' | 'warn' | 'refuse'
  /** The bucket with the least left, the one the verdict is about. */
  lowest?: Bucket
}

export function gateOf(buckets: Bucket[]): Gate {
  const lowest = [...buckets].sort((a, b) => a.remaining - b.remaining)[0]
  if (!lowest) return { verdict: 'ok' }
  return { verdict: lowest.remaining <= REFUSE_AT ? 'refuse' : lowest.remaining <= WARN_AT ? 'warn' : 'ok', lowest }
}

/** How long until a time, as "2 h 5 min", and the time in UTC. */
export function resetText(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const span = days > 0 ? `${days} d ${hours} h` : hours > 0 ? `${hours} h ${rest} min` : `${rest} min`
  return `resets in about ${span} (at ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC)`
}

export function bucketLine(bucket: Bucket, now: number): string {
  const reset = resetText(bucket.resetsAt, now)
  return `${bucket.label}: ${Math.round(bucket.remaining * 100)}% left${reset ? `, ${reset}` : ''}`
}

/** Runs `agy -p /usage` in an empty folder, with slash commands on (with them off it would be a prompt that spends quota). */
export async function readUsage(agy: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Bucket[] | { error: string }> {
  const run = await runProcess([agy, '-p', '/usage', '--output-format', 'json'], { cwd, env: agyEnv(env), timeoutMs: 30_000 })
  if (run.timedOut) return { error: 'agy /usage timed out.' }
  if (run.spawnError) return { error: `agy could not start: ${firstLine(run.spawnError)}` }
  return parseUsage(run.stdout)
}
