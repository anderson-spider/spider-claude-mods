import { typeOf } from './files'
import type { Kind, Request, ReviewTarget } from './model'

// A Codex session id, as `thread.started` prints it.
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A model name as `-m` takes it, and an effort level as the config takes it: no quote can reach the TOML value.
const MODEL = /^[\w.:/-]+$/
const EFFORT = /^[a-z]+$/
// A commit or branch as `--commit` and `--base` take it (a sha, tag, `HEAD~1`, any name): one word with no leading dash,
// so it never reads as a flag; git and Codex judge the rest.
const REF = /^(?!-)\S+$/

// A string value without its surrounding blanks, or undefined when it is not a string or holds only blanks.
const trimmedOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Where the answer goes (an absolute `out`) and how much of it is shown inline, or the error to answer. */
function outputOf(e: Record<string, unknown>): { out?: string; maxChars?: number } | string {
  const out = trimmedOf(e.out)
  if (out && !out.startsWith('/')) return `${out} must be an absolute path.`
  const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : undefined
  return { ...(out ? { out } : {}), ...(maxChars ? { maxChars } : {}) }
}

/** The run's model and effort, as shapes that cannot break the TOML value, or the error to answer. */
function tuningOf(e: Record<string, unknown>): { model?: string; effort?: string } | string {
  const model = trimmedOf(e.model)
  if (model && !MODEL.test(model)) return `${model} is not a model name.`
  const effort = trimmedOf(e.effort)?.toLowerCase()
  if (effort && !EFFORT.test(effort)) return `${effort} is not an effort level (a word such as low, medium or high).`
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** Reads a tool call's input into a request, or the error to answer. Images among `files` go to Codex as images. */
export function requestOf(kind: Kind, e: Record<string, unknown>): Request | string {
  const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
  if (!prompt) return 'Give a non-empty prompt.'
  const threadId = trimmedOf(e.threadId)
  if (threadId && !THREAD_ID.test(threadId)) return `${threadId} is not a Codex thread id; pass the threadId an earlier call returned.`
  const tuning = tuningOf(e)
  if (typeof tuning === 'string') return tuning
  const { model, effort } = tuning
  const paths = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const reference = trimmedOf(e.reference)
  if (reference && !typeOf(reference)) return `${reference} must be a PNG, JPEG, WebP or GIF image.`
  const relative = [...(reference ? [reference] : []), ...paths].find(path => !path.startsWith('/'))
  if (relative) return `${relative} must be an absolute path.`
  const output = outputOf(e)
  if (typeof output === 'string') return output
  return {
    kind,
    prompt,
    threadId,
    model,
    effort,
    images: [...(reference ? [reference] : []), ...paths.filter(path => typeOf(path))],
    files: paths.filter(path => !typeOf(path)),
    ...output,
  }
}

/** A command's text as a request: the trimmed text is the whole prompt; a blank text answers the usage. */
export function commandRequestOf(kind: Kind, args: string, usage: string): Request | string {
  const prompt = args.trim()
  return prompt ? { kind, prompt, images: [], files: [] } : usage
}

const TARGETS = ['base', 'commit', 'uncommitted', 'instructions'] as const

/**
 * Reads a review tool call's input into a request with one target at most. Without one, the review covers the branch
 * against its default base, which register.tsx resolves from the repository; resolveReview (review.ts) also names
 * the run, as `prompt`, for file names and the jobs list.
 */
export function reviewRequestOf(e: Record<string, unknown>): Request | string {
  const tuning = tuningOf(e)
  if (typeof tuning === 'string') return tuning
  const given = TARGETS.filter(key => (key === 'uncommitted' ? e.uncommitted === true : trimmedOf(e[key]) !== undefined))
  if (given.length > 1) return `Give one review target at most: base, commit, uncommitted or instructions (got ${given.join(', ')}).`
  const output = outputOf(e)
  if (typeof output === 'string') return output
  const target = targetOf(given[0], e)
  if (typeof target === 'string') return target
  return { kind: 'review', prompt: '', images: [], files: [], ...tuning, ...(target ? { review: target } : {}), ...output }
}

function targetOf(key: (typeof TARGETS)[number] | undefined, e: Record<string, unknown>): ReviewTarget | string | undefined {
  if (key === 'uncommitted') return { uncommitted: true }
  const value = key && trimmedOf(e[key])
  if (!key || !value) return undefined
  if (key === 'commit') return REF.test(value) ? { commit: value } : `${value} is not a commit.`
  if (key === 'base') return REF.test(value) ? { base: value } : `${value} is not a branch name.`
  // After `--`, a lone `-` still tells `codex exec review` to read the instructions from stdin.
  if (value === '-') return 'Give the review instructions as text; "-" would make Codex read them from stdin.'
  return { instructions: value }
}
