import type { Settings } from './service'

// The defaults of the `foregroundMinutes` and `backgroundMinutes` options, as plugin.json declares them.
const FOREGROUND_MINUTES = 2
const BACKGROUND_MINUTES = 30

// A time limit setting in minutes as milliseconds: the default when it is not a positive number, 24 h at most.
export function limitMs(raw: unknown, defaultMinutes: number): number {
  const minutes = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return Math.round(defaultMinutes * 60_000)
  return Math.round(Math.min(minutes, 24 * 60) * 60_000)
}

const optionOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** The plugin's options as both sides read them: the hooks module from register, the MCP server from its environment, where an unset one is empty. */
export function settingsOf(options: Record<string, unknown> | undefined): Settings {
  const agyPath = optionOf(options?.agyPath)
  const defaultModel = optionOf(options?.defaultModel)
  return {
    foregroundMs: limitMs(options?.foregroundMinutes, FOREGROUND_MINUTES),
    backgroundMs: limitMs(options?.backgroundMinutes, BACKGROUND_MINUTES),
    ...(agyPath ? { agyPath } : {}),
    ...(defaultModel ? { defaultModel } : {}),
  }
}
