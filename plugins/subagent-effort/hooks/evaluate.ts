// The evaluation behind /subagent-effort-eval, pure: how one assessment of a fixed brief compares with the level a
// person judged it needs, and the table of every round. Jev's level is compared, not the effort a cap would apply.
import { EFFORTS, jevCostOf, TASK_CHARS } from './effort'
import type { Choice } from './effort'
import type { EvalBrief, EvalSplit } from './eval-briefs'
import { usd } from './ledger'

/** A hit, a level above or below the expected one, a failed assessment, or a long brief rated by its head alone. */
export type Verdict = 'hit' | 'over' | 'under' | 'failed' | 'partial'
export type Rated = { id: string; verdict: Verdict; level: number | null; head: number | null; full: number | null; reason: string | null; costUsd: number }

export const MAX_ROUNDS = 5
export const DEFAULT_ROUNDS = 3

/** One assessment of a brief against its expected level. */
export function rated(brief: EvalBrief, choice: Choice): Rated {
  const base = { id: brief.id, level: choice.level, head: choice.headLevel ?? null, full: choice.fullLevel ?? null, reason: choice.jevReason, costUsd: choice.jevTokens ? jevCostOf(choice.jevTokens) : 0 }
  if (choice.jevReason || choice.level === null) return { ...base, verdict: 'failed' }
  if (brief.task.length > TASK_CHARS && choice.fullLevel == null) return { ...base, verdict: 'partial' }
  return { ...base, verdict: choice.level === brief.expected ? 'hit' : choice.level > brief.expected ? 'over' : 'under' }
}

/** `[rounds] [dev|holdout]` in any order: rounds from 1 to MAX_ROUNDS (DEFAULT_ROUNDS when absent), every split when none is named. */
export function evalArgs(args: string): { rounds: number; split: EvalSplit | null } | { error: string } {
  let rounds = DEFAULT_ROUNDS, split: EvalSplit | null = null
  for (const word of args.trim().split(/\s+/).filter(Boolean)) {
    if (word === 'dev' || word === 'holdout') split = word
    else if (/^\d+$/.test(word) && Number(word) >= 1 && Number(word) <= MAX_ROUNDS) rounds = Number(word)
    else return { error: `usage: /subagent-effort-eval [1-${MAX_ROUNDS}] [dev|holdout]` }
  }
  return { rounds, split }
}

const digit = (n: number | null) => (n === null ? '-' : String(n))
const VERDICTS: readonly Verdict[] = ['hit', 'over', 'under', 'failed', 'partial']

/**
 * One line per brief (its split, the expected level and each round's decided level, with the head's and the full
 * brief's levels in brackets), a mark on a brief whose decision varied between rounds, then the counts per split and
 * the Jev cost of every call. Levels are indexes of EFFORTS.
 */
export function formatEval(briefs: readonly EvalBrief[], rounds: readonly (readonly Rated[])[]): string {
  const cost = rounds.flat().reduce((sum, r) => sum + r.costUsd, 0)
  const head = `${briefs.length} briefs × ${rounds.length} rounds; levels 0-3 are ${EFFORTS.join(', ')}; each round shows decided(head/full).`
  const lines = briefs.map((brief, i) => {
    const runs = rounds.map(round => round[i]!)
    const varied = new Set(runs.map(r => r.level)).size > 1
    const shown = runs.map(r => (r.verdict === 'failed' ? `failed:${r.reason ?? '?'}` : `${digit(r.level)}(${digit(r.head)}/${digit(r.full)})`)).join(' ')
    return `${brief.id} [${brief.split}] expected ${brief.expected}: ${shown}${varied ? ' varies' : ''}`
  })
  const splits = [...new Set(briefs.map(b => b.split))].map(split => {
    const verdicts = rounds.flatMap(round => round.filter((_, i) => briefs[i]!.split === split).map(r => r.verdict))
    return `${split}: ${VERDICTS.map(v => `${verdicts.filter(x => x === v).length} ${v}`).join(', ')}.`
  })
  return [head, ...lines, ...splits, `Jev cost about ${usd(cost)} (estimated).`].join('\n')
}
