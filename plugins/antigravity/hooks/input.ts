import type { Kind, Request, ReviewTarget } from './model'
import { EFFORTS } from './tool-schemas'

// An agy conversation id, as the `init` event prints it.
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A model id as `agy models` prints it; `agy models` itself decides which exist.
const MODEL = /^[\w.:/-]+$/
// A commit or branch as git takes it (a sha, tag, `HEAD~1`, any name): one word with no leading dash, so it never reads
// as a flag; git judges the rest.
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

/** The run's model and effort, or the error to answer; a model with no `model` given is the plugin's default. */
function tuningOf(e: Record<string, unknown>, defaultModel: string | undefined): { model?: string; effort?: string } | string {
  const model = trimmedOf(e.model) ?? defaultModel
  if (model && !MODEL.test(model)) return `${model} is not a model id.`
  const effort = trimmedOf(e.effort)?.toLowerCase()
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) return `${effort} is not an effort level (${EFFORTS.join(', ')}).`
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

/** Reads an ask tool call's input into a request, or the error to answer. */
export function askRequestOf(e: Record<string, unknown>, defaultModel?: string): Request | string {
  const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
  if (!prompt) return 'Give a non-empty prompt.'
  const conversationId = trimmedOf(e.conversationId)
  if (conversationId && !CONVERSATION_ID.test(conversationId)) {
    return `${conversationId} is not an agy conversation id; pass the conversationId an earlier call returned.`
  }
  const tuning = tuningOf(e, defaultModel)
  if (typeof tuning === 'string') return tuning
  const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const relative = files.find(path => !path.startsWith('/'))
  if (relative) return `${relative} must be an absolute path.`
  const output = outputOf(e)
  if (typeof output === 'string') return output
  return { kind: 'ask', prompt, ...(conversationId ? { conversationId } : {}), ...tuning, files, ...output }
}

/** A command's text as an ask: the trimmed text is the whole prompt; a blank text answers the usage. */
export function commandRequestOf(args: string, usage: string, defaultModel?: string): Request | string {
  const prompt = args.trim()
  return prompt ? { kind: 'ask' as Kind, prompt, ...(defaultModel ? { model: defaultModel } : {}), files: [] } : usage
}

/**
 * Reads a review tool call's input into a request with one target at most. Without one, the review covers the branch
 * against its default base, which resolveReview (review.ts) finds in the repository and also names the run by.
 */
export function reviewRequestOf(e: Record<string, unknown>, defaultModel?: string): Request | string {
  const tuning = tuningOf(e, defaultModel)
  if (typeof tuning === 'string') return tuning
  const base = trimmedOf(e.base)
  const commit = trimmedOf(e.commit)
  if (base && commit) return 'Give one review target at most: base or commit.'
  let review: ReviewTarget | undefined
  if (base) {
    if (!REF.test(base)) return `${base} is not a branch name.`
    review = { base }
  } else if (commit) {
    if (!REF.test(commit)) return `${commit} is not a commit.`
    review = { commit }
  }
  const output = outputOf(e)
  if (typeof output === 'string') return output
  const focus = trimmedOf(e.focus)
  return { kind: 'review', prompt: '', files: [], ...tuning, ...(review ? { review } : {}), ...(focus ? { focus } : {}), ...output }
}
