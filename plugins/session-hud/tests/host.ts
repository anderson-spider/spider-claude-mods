// The host fake the plugin's tests share: the session's model, usage and theme, the clock, the transcript, and the band
// to mount.
import type { On, RenderElement, ToolUseSummary } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

export const NOW = Date.parse('2026-10-13T12:00:00Z')
const HOUR = 3_600_000

/** What `$.session.usage()` answers by default: a fifth of the window, both windows and a cost. */
export const USAGE = {
  startedAt: NOW - HOUR,
  context: { tokens: 200_000, window: 1_000_000, percent: 20 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 74, resetsAt: new Date(NOW + 38 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 60, resetsAt: new Date(NOW + 84 * HOUR).toISOString() },
  ],
  cost: { usd: 4.43 },
}

/** What git answers for the session's directory: its working tree, the folder within it, the git dirs and the branch (empty on a detached head). */
export type Repo = { top: string; prefix: string; gitDir: string; common: string; branch: string }

/** A host with the session's model, usage, theme, directory and clock (stopped at NOW, or moving with the test's advances when `moving`); `transcript` is what `$.session.messages()` answers, and `place.repo` is what git answers for `place.cwd` (no repository when absent). */
export function world(on: On, opts: { theme?: string; window?: number; moving?: boolean; repo?: Repo; fork?: string; refuseFill?: boolean } = {}) {
  const place: { cwd: string; repo?: Repo } = { cwd: '/proj', ...(opts.repo ? { repo: opts.repo } : {}) }
  const transcript: { role: 'user' | 'assistant'; text: string; toolUses: ToolUseSummary[] }[] = []
  on('session.messages', () => ({ value: transcript }) as never)
  // `mock.clock` registers `clock.now` itself and the engine refuses a second one: the test's own reads NOW.
  const clock = mock.clock(((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On, { now: NOW })
  on('clock.now', () => ({ value: opts.moving ? clock.now() : NOW }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', (_$, e) => ({ value: (e as { breakdown?: string }).breakdown
    ? { ...USAGE, context: { ...USAGE.context, breakdown: { rawMaxTokens: opts.window ?? 1_000_000 } } } : USAGE }) as never)
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme ?? 'dark' }] }) as never)
  on('config.set', (_$, e) => ({ value: e.value }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }) as never)
  on('classic.PostModelSwitch', () => ({}) as never)
  on('classic.PostCompact', () => ({}) as never)
  on('classic.CwdChanged', () => ({}) as never)
  on('session.cwd', () => ({ value: place.cwd }))
  const ran = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_$, e) => {
    const repo = place.repo
    const args = e.argv.slice(2).join(' ')
    if (e.argv[0] !== 'git' || !repo) return ran(128, '', 'fatal: not a git repository')
    if (args.startsWith('rev-parse')) return ran(0, `${repo.top}\n${repo.prefix}\n${repo.gitDir}\n${repo.common}\n`)
    if (args === 'branch --show-current') return ran(0, repo.branch ? `${repo.branch}\n` : '')
    return ran(1)
  })
  // Opus answers with 95% of its input cached and 5 output tokens, each request reading 100 more cached tokens than the
  // one before; any other model as named, uncached, with 700.
  let opus = 0
  on('turn.step', async function* (_$, e) {
    const usage = e.model === 'claude-opus-5-5'
      ? { model: e.model, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 950 + 100 * opus++, cache_creation_input_tokens: 40 }
      : { model: e.model, input_tokens: 1_000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  // What draws beneath the card in the band: another plugin's tree, such as a row of suggestions.
  on('ui.render', { component: 'AbovePrompt' }, () => BENEATH)
  // The next steps: the fork answers `opts.fork` (nothing to fork without it), the session has two commands, and the
  // prompt box takes a fill unless `refuseFill`; what reached the fork, the box, its ghost text and the toasts is kept.
  const asked: string[] = []
  const fills: string[] = []
  const suggested: string[] = []
  const toasts: string[] = []
  on('model.fork', (_$, e) => {
    asked.push(e.prompt)
    return { value: opts.fork === undefined ? { isAnswered: false, reason: 'nothing-to-fork' } : { isAnswered: true, text: opts.fork, usage: {} } } as never
  })
  on('command.list', () => ({ value: [
    { name: 'code-review', description: 'Review the current diff', source: 'plugin' },
    { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  ] }) as never)
  on('prompt.fill', (_$, e) => (opts.refuseFill ? { isFilled: false } : (fills.push(e.text), { isFilled: true })) as never)
  on('prompt.suggest', (_$, e) => (suggested.push(e.text), { isShown: true }) as never)
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  return { clock, place, transcript, asked, fills, suggested, toasts }
}

/** The band's tree beneath the card. */
export const BENEATH: RenderElement = { type: 'Text', props: {}, children: ['beneath'] }

export const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)

export const band = (columns = 110, hasSurvey = false, isWorking = false) => ({
  plugin: 'session-hud', component: 'AbovePrompt', surface: 'terminal',
  props: { hasSurvey, isCollapsed: false, isWorking, maxRows: 20, bodyColumns: columns, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

/** A tool call the transcript holds, answered with `text` (an error with `isError`), or in flight without it. */
export const used = (id: string, tool: string, text?: string, isError = false): ToolUseSummary =>
  ({ tool_use_id: id, tool, input: {}, ...(text !== undefined ? { text } : {}), ...(isError ? { isError: true as const } : {}) })

/** The text a mounted surface drew, one Text per line. */
export const drawn = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(found => found.text).join('\n')

/** A main-session step (or a subagent's, with `agentId`) on `model` at `effort`, run to its result. */
export const step = async ($: Engine, agentId?: string, model = 'claude-opus-5-5', effort = 'medium') => {
  const stream = $.turn.step({ turnId: 't1', index: 0, model, effort, messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
export const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
export const flush = async () => { for (let i = 0; i < 10; i++) await pause() }
