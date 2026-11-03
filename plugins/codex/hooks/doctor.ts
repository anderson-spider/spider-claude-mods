import type { Check, ProcessRunner } from './model'
import { errorText } from './presentation'

/** The top-level `model` and `model_reasoning_effort` of a Codex config.toml: the keys before its first table. */
export function defaultsOf(toml: string): { model?: string; effort?: string } {
  const top = toml.split(/^\s*\[/m)[0] ?? ''
  const value = (key: string) => top.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1]
  return { model: value('model'), effort: value('model_reasoning_effort') }
}

export type DoctorDeps = {
  codex: string | { error: string }
  run: ProcessRunner
  /** The text of `$CODEX_HOME/config.toml`, or undefined when there is none. */
  config(): Promise<string | undefined>
  configPath: string
}

/** What /codex-doctor checks: the executable, its version, its login and the defaults a run without overrides uses. */
export async function diagnose(deps: DoctorDeps): Promise<Check[]> {
  if (typeof deps.codex !== 'string') return [{ name: 'codex', ok: false, detail: deps.codex.error }]
  const codex = deps.codex
  const checks: Check[] = [{ name: 'codex', ok: true, detail: codex }]
  const line = async (name: string, argv: string[]) => {
    try {
      const done = await deps.run([codex, ...argv], { timeoutMs: 20_000 })
      const text = (done.stdout.trim() || done.stderr.trim()).split('\n')[0] ?? ''
      checks.push({ name, ok: done.exitCode === 0, detail: text || `exit code ${done.exitCode}` })
    } catch (error) {
      checks.push({ name, ok: false, detail: errorText(error) })
    }
  }
  await line('version', ['--version'])
  await line('login', ['login', 'status'])
  const toml = await deps.config().catch(() => undefined)
  const { model, effort } = defaultsOf(toml ?? '')
  checks.push({
    name: 'defaults',
    ok: true,
    detail: `model ${model ?? "Codex's default"}, effort ${effort ?? "Codex's default"} (${toml === undefined ? `no ${deps.configPath}` : deps.configPath}); a call's model and effort override them`,
  })
  return checks
}

export function report(checks: Check[]): string {
  const lines = checks.map(check => `${check.ok ? '✓' : '✗'} ${check.name}: ${check.detail}`)
  if (checks.some(check => check.name === 'login' && !check.ok)) lines.push('Sign in with `! codex login`.')
  return lines.join('\n')
}
