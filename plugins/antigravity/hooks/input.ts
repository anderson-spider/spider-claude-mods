import { IMAGE_FILE, folderOf, readsOf, within } from './args'
import type { Kind, Request, ReviewTarget } from './model'
import { EFFORTS } from './tool-schemas'

// An agy conversation id, as the `init` event prints it.
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A model id as `agy models` prints it; `agy models` itself decides which exist.
const MODEL = /^[\w.:/-]+$/
// A commit or branch as git takes it (a sha, tag, `HEAD~1`, any name): one word with no leading dash, so it never reads
// as a flag; git judges the rest.
const REF = /^(?!-)\S+$/

// An absolute path with no `.`, `..` or empty part, so where it points is where it reads.
const isClean = (path: string) => !path.split('/').slice(1).some(part => part === '' || part === '.' || part === '..')

/** The error for a path that is not absolute, or not clean, else undefined. */
const pathError = (path: string) =>
  !path.startsWith('/') ? `${path} must be an absolute path.` : isClean(path) ? undefined : `${path} must be an absolute path without . or .. parts.`

// A string value without its surrounding blanks, or undefined when it is not a string or holds only blanks.
const trimmedOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Where the answer goes (an absolute `out`) and how much of it is shown inline, or the error to answer. */
function outputOf(e: Record<string, unknown>): { out?: string; maxChars?: number } | string {
  const out = trimmedOf(e.out)
  const bad = out && pathError(out)
  if (bad) return bad
  const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : undefined
  return { ...(out ? { out } : {}), ...(maxChars ? { maxChars } : {}) }
}

// The effort a model id names at its end (`gemini-4-argon-high`): agy refuses `--effort` with such a model. Its ids
// come in these efforts only.
const NAMED_EFFORT = /-(low|medium|high|xhigh|max)$/i
const MODEL_EFFORTS = ['low', 'medium', 'high']

/**
 * The run's model and effort, or the error to answer; a model with no `model` given is the plugin's default. agy
 * rejects `--effort` with a model id that names its own effort: an effort equal to the named one is dropped, another
 * one with an explicit model is refused, and with the default model it picks the default's variant of that effort
 * (checkedModel then makes sure agy lists it).
 */
function tuningOf(e: Record<string, unknown>, defaultModel: string | undefined): { model?: string; effort?: string } | string {
  const given = trimmedOf(e.model)
  const model = given ?? defaultModel
  if (model && !MODEL.test(model)) return `${model} is not a model id.`
  const effort = trimmedOf(e.effort)?.toLowerCase()
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) return `${effort} is not an effort level (${EFFORTS.join(', ')}).`
  const named = model && NAMED_EFFORT.exec(model)?.[1]?.toLowerCase()
  if (!effort || !model || !named) return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  if (effort === named) return { model }
  const which = given ? model : `The defaultModel ${model}`
  if (!MODEL_EFFORTS.includes(effort)) return `${which} names its effort, and agy model ids come in ${MODEL_EFFORTS.join(', ')} only; leave effort out or pass a model id.`
  const variant = model.replace(NAMED_EFFORT, `-${effort}`)
  if (given) return `${model} already names its effort; pass the model id with the effort you want (such as ${variant}) and leave effort out.`
  return { model: variant }
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
  const bad = files.map(pathError).find(Boolean)
  if (bad) return bad
  const output = outputOf(e)
  if (typeof output === 'string') return output
  return { kind: 'ask', prompt, ...(conversationId ? { conversationId } : {}), ...tuning, files, ...output }
}

/** Reads an image tool call's input into a request, or the error to answer. */
export function imageRequestOf(e: Record<string, unknown>, defaultModel?: string): Request | string {
  const asked = askRequestOf({ ...e, files: [], maxChars: undefined }, defaultModel)
  if (typeof asked === 'string') return asked
  const reference = trimmedOf(e.reference)
  if (reference) {
    const bad = pathError(reference)
    if (bad) return bad
    if (!IMAGE_FILE.test(reference)) return `${reference} is not a PNG, JPEG, WebP or GIF image.`
  }
  return { ...asked, kind: 'image', ...(reference ? { reference } : {}) }
}

/** A command's text as an ask (or an image): the trimmed text is the whole prompt; a blank text answers the usage. */
export function commandRequestOf(args: string, usage: string, defaultModel?: string, kind: Kind = 'ask'): Request | string {
  const prompt = args.trim()
  return prompt ? { kind, prompt, ...(defaultModel ? { model: defaultModel } : {}), files: [] } : usage
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

/**
 * The error when a request reaches past what it needs: a listed file outside the project whose folder is the home
 * folder or above (agy gets each such file's whole folder with `--add-dir`; an image's reference counts), or an answer saved outside the project
 * and the answers folder, or inside a `.git` folder. The answer is agy's text, so it never lands in a shell profile
 * or a key file.
 */
export function placementError(request: Request, at: { project: string; outDir: string; home?: string }): string | undefined {
  for (const path of readsOf(request)) {
    if (within(path, at.project)) continue
    const dir = folderOf(path)
    if (dir === '/' || (at.home && within(at.home, dir))) return `${path} is in ${dir}, and agy would get that whole folder; copy the file into a narrower folder first.`
  }
  const { out } = request
  if (!out) return undefined
  if (!within(out, at.project) && !within(out, at.outDir)) return `${out} is outside the project and ${at.outDir}; save it in one of them.`
  if (out.toLowerCase().split('/').includes('.git')) return `${out} is inside a .git folder; save it elsewhere.`
  return undefined
}
