// Pure updates of the card from what the host reported. register.tsx owns every `$` call and passes the figures in.
import type { SessionHudCard, SessionHudLimit, SessionHudTurn, SessionHudWorkspace } from '../types'
import { sameWorkspace } from './workspace'
import { cacheShare } from './usage'

export const EMPTY: SessionHudCard = { limits: [], edits: 0, errors: 0, turns: 0, history: [] }

/** The turns the card keeps: the last one in figures, and the one before it for what was sent in between. */
export const HISTORY = 2

/** What the host measures: the context and the rate-limit windows (`session.measure`, `$.session.usage()`). */
export type Measured = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: readonly SessionHudLimit[]
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** A measurement replaces the context and the windows. */
export function measured(card: SessionHudCard, usage: Measured): SessionHudCard {
  const { tokens, window, percent } = usage.context
  const context = finite(window) ? { window, ...(finite(tokens) ? { tokens } : {}), ...(finite(percent) ? { percent } : {}) } : undefined
  const limits = usage.rateLimits.filter(limit => typeof limit.kind === 'string' && finite(limit.percentUsed))
    .map(limit => ({ kind: limit.kind, percentUsed: limit.percentUsed, ...(typeof limit.resetsAt === 'string' ? { resetsAt: limit.resetsAt } : {}) }))
  return context ? { ...card, limits, context } : { ...card, limits }
}

const count = (n: unknown): n is number => finite(n) && n >= 0

type StepUsage = { model: string; input_tokens: number; output_tokens?: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** Whether a step's request read or wrote the prompt cache. */
export const touchedCache = (usage: StepUsage | null): boolean =>
  usage !== null && count(usage.cache_read_input_tokens) && count(usage.cache_creation_input_tokens) && usage.cache_read_input_tokens + usage.cache_creation_input_tokens > 0

/** The prompt cache was read or written at `at`. */
export const cacheUsed = (card: SessionHudCard, at: unknown): SessionHudCard => (finite(at) ? { ...card, cacheUsedAt: at } : card)

/** A main-session step: its effort and, from its usage, the model that answered, the cache share and the running turn's context (the first prompt, the last prompt plus its output). */
export function stepped(card: SessionHudCard, effort: unknown, usage: StepUsage | null): SessionHudCard {
  const next = { ...card }
  if (typeof effort === 'string') next.effort = effort
  if (usage) {
    if (typeof usage.model === 'string') next.model = usage.model
    const share = cacheShare(usage)
    if (share !== undefined) next.cache = share
    const output = count(usage.output_tokens) ? usage.output_tokens : undefined
    const { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: written } = usage
    if (count(input) && count(read) && count(written) && output !== undefined) {
      const prompt = input + read + written
      next.pending = { before: card.pending?.before ?? prompt, after: prompt + output, output: (card.pending?.output ?? 0) + output }
    }
  }
  return next
}

/** A model switch: the cache's lifetime as the host reported it (`5m` or `1h`, anything else kept as it was); a switch to another model forfeits the cache, so its last use is forgotten. */
export function switched(card: SessionHudCard, ttl: unknown, from: unknown, to: unknown): SessionHudCard {
  const next: SessionHudCard = ttl === '5m' || ttl === '1h' ? { ...card, cacheTtl: ttl } : { ...card }
  if (from !== to) delete next.cacheUsedAt
  return next
}

/** A compaction ran: the next turn to join the history is marked. */
export const compactedNow = (card: SessionHudCard): SessionHudCard => ({ ...card, compacted: true })

/** The window the host compacts against (`rawMaxTokens` of a context breakdown); anything but a positive count leaves it. */
export const windowed = (card: SessionHudCard, window: unknown): SessionHudCard =>
  finite(window) && window > 0 ? { ...card, contextWindow: window } : card

/** A main-session turn began: its context starts afresh. */
export function began(card: SessionHudCard): SessionHudCard {
  const { pending: _left, ...rest } = card
  return rest
}

/** The running main-session turn began at `at`. */
export const timed = (card: SessionHudCard, at: unknown): SessionHudCard => (finite(at) ? { ...card, turnStartedAt: at } : card)

const turnsOf = (card: SessionHudCard): SessionHudTurn[] => (Array.isArray(card.history) ? card.history : [])

/** A main-session turn ended after `durationMs`: it is no longer running, it counts, and its context joins the history. */
export function completed(card: SessionHudCard, durationMs: unknown): SessionHudCard {
  const { turnStartedAt: _ended, pending, compacted, ...rest } = card
  const history = pending ? [...turnsOf(card), compacted ? { ...pending, compacted } : pending].slice(-HISTORY) : turnsOf(card)
  const counted: SessionHudCard = { ...rest, history, turns: card.turns + 1, ...(!pending && compacted ? { compacted } : {}) }
  return finite(durationMs) && durationMs >= 0 ? { ...counted, lastTurnMs: durationMs } : counted
}

const EDITS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit'])

/** A tool call as the transcript holds it: its id, the tool, and once answered the text the model read and whether it was an error. */
export type ToolUse = { tool_use_id: string; tool: string; text?: string; isError?: true }

/** The answered calls among `uses` whose id is not in `seen`, each once: a call still in flight waits for a later reading. */
export function unseen(uses: readonly ToolUse[], seen: ReadonlySet<string>): ToolUse[] {
  const fresh = new Map<string, ToolUse>()
  for (const use of uses) if (typeof use.tool_use_id === 'string' && use.text !== undefined && !seen.has(use.tool_use_id)) fresh.set(use.tool_use_id, use)
  return [...fresh.values()]
}

/** Answered main-session tool calls: each error counts, and each edit that did not end in one; anything else leaves the card as it is. */
export function counted(card: SessionHudCard, uses: readonly ToolUse[]): SessionHudCard {
  let { edits, errors } = card
  for (const use of uses) {
    if (use.isError === true) errors++
    else if (EDITS.has(use.tool)) edits++
  }
  return edits === card.edits && errors === card.errors ? card : { ...card, edits, errors }
}

/** Where the session works, as last read; an unchanged reading leaves the card as it was, and none clears it. */
export const located = (card: SessionHudCard, workspace: SessionHudWorkspace | undefined): SessionHudCard => {
  if (sameWorkspace(card.workspace, workspace)) return card
  const { workspace: _gone, ...rest } = card
  return workspace ? { ...rest, workspace } : rest
}
