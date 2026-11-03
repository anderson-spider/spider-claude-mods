import { typeOf } from './files'
import type { Kind, Request } from './model'

// A Codex session id, as `thread.started` prints it.
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A model name as `-m` takes it, and an effort level as the config takes it: no quote can reach the TOML value.
const MODEL = /^[\w.:/-]+$/
const EFFORT = /^[a-z]+$/

// A string value without its surrounding blanks, or undefined when it is not a string or holds only blanks.
const trimmedOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Reads a tool call's input into a request, or the error to answer. Images among `files` go to Codex as images. */
export function requestOf(kind: Kind, e: Record<string, unknown>): Request | string {
  const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : ''
  if (!prompt) return 'Give a non-empty prompt.'
  const threadId = trimmedOf(e.threadId)
  if (threadId && !THREAD_ID.test(threadId)) return `${threadId} is not a Codex thread id; pass the threadId an earlier call returned.`
  const model = trimmedOf(e.model)
  if (model && !MODEL.test(model)) return `${model} is not a model name.`
  const effort = trimmedOf(e.effort)?.toLowerCase()
  if (effort && !EFFORT.test(effort)) return `${effort} is not an effort level (a word such as low, medium or high).`
  const paths = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const reference = trimmedOf(e.reference)
  if (reference && !typeOf(reference)) return `${reference} must be a PNG, JPEG, WebP or GIF image.`
  const relative = [...(reference ? [reference] : []), ...paths].find(path => !path.startsWith('/'))
  if (relative) return `${relative} must be an absolute path.`
  const out = trimmedOf(e.out)
  if (out && !out.startsWith('/')) return `${out} must be an absolute path.`
  const maxChars = typeof e.maxChars === 'number' && e.maxChars > 0 ? Math.floor(e.maxChars) : undefined
  return {
    kind,
    prompt,
    threadId,
    model,
    effort,
    images: [...(reference ? [reference] : []), ...paths.filter(path => typeOf(path))],
    files: paths.filter(path => !typeOf(path)),
    out,
    maxChars,
  }
}

/** A command's text as a request: the trimmed text is the whole prompt; a blank text answers the usage. */
export function commandRequestOf(kind: Kind, args: string, usage: string): Request | string {
  const prompt = args.trim()
  return prompt ? { kind, prompt, images: [], files: [] } : usage
}
