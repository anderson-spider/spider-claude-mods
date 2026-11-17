import type { Entry, Finding, OutputDeps, Outcome, Preview, Request, RunResult } from './model'
import { IMAGE_FILE } from './args'
import { askOutcome, failure, imageSummary, NO_STRUCTURED_FINDINGS, withFindingsFile } from './presentation'

// The longest side of the preview an image request hands back with its files.
const PREVIEW_SIDE = 768

/** A file name for an answer or an image: timestamp plus a slug of the prompt. */
export function fileName(prompt: string, now: Date, extension = 'md'): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const slug = prompt
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${stamp}-${slug || 'answer'}.${extension}`
}

/** A conversation's artifacts folder, where agy's image-generator subagent saves its images. */
export const artifactsOf = (deps: Pick<OutputDeps, 'artifactsRoot'>, conversationId: string) => `${deps.artifactsRoot}/${conversationId}`

// The images in a conversation's artifacts folder (its top level only), oldest first; none when it is missing.
async function imagesIn(deps: Pick<OutputDeps, 'list'>, dir: string): Promise<Entry[]> {
  const entries = await deps.list(dir).catch(() => [])
  return entries.filter(entry => entry.kind === 'file' && IMAGE_FILE.test(entry.name)).sort((a, b) => a.mtimeMs - b.mtimeMs)
}

// An image as the before and after listings compare it: its name and when it last changed, so one agy rewrote counts.
const stampOf = (entry: Entry) => `${entry.name}@${entry.mtimeMs}`

/** The images already in a conversation's artifacts folder, so a follow-up saves only the images it adds or rewrites. */
export async function imagesBefore(deps: Pick<OutputDeps, 'list' | 'artifactsRoot'>, conversationId: string | undefined): Promise<string[]> {
  return conversationId ? (await imagesIn(deps, artifactsOf(deps, conversationId))).map(stampOf) : []
}

/** Adds a number to a path only when the run saved more than one image. */
export const variantPath = (base: string, index: number, count: number) => (count > 1 ? base.replace(/(\.\w+)?$/, `-${index + 1}$1`) : base)

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

// A path with the extension of the image it holds: an `out` named .png that agy filled with a JPEG becomes .jpg.
const withExtension = (path: string, extension: string) => `${path.replace(/\.\w+$/, '')}.${extension}`

// A small JPEG of a saved image (sips, on macOS), so the model sees it at once; none elsewhere. It is made in the
// answers folder, never beside an `out` in the project, where a file of that name could be.
async function previewOf(deps: Pick<OutputDeps, 'run' | 'readBytes' | 'outDir'>, path: string): Promise<Preview | undefined> {
  const small = `${deps.outDir}/.preview-${path.split('/').pop()}.jpg`
  try {
    const done = await deps.run(['sips', '-Z', String(PREVIEW_SIDE), '-s', 'format', 'jpeg', path, '--out', small], { timeoutMs: 30_000 })
    if (done.exitCode !== 0) return undefined
    const { base64 } = await deps.readBytes(small)
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }
  } catch {
    return undefined
  } finally {
    await deps.run(['rm', '-f', small]).catch(() => undefined)
  }
}

/**
 * Copies the images the run added to its conversation's artifacts folder (the names in `before` were there already)
 * to the request's `out`, numbered when there are several, else to the answers folder, oldest first, with previews,
 * and saves a Markdown record of the request in the answers folder, never beside an `out` in the project. agy's stream names no image, so the folder decides.
 */
export async function saveImages(deps: OutputDeps, result: RunResult, request: Request, before: string[], model: string | undefined): Promise<Outcome> {
  const { conversationId, message } = result
  if (result.error || !conversationId) {
    return failure(result.error ?? 'agy ended without a conversation.', { conversationId, timedOut: result.timedOut, hint: !result.timedOut })
  }
  const dir = artifactsOf(deps, conversationId)
  const added = (await imagesIn(deps, dir)).filter(entry => !before.includes(stampOf(entry)))
  const said = message?.trim() ? `agy said: ${message.trim()}` : undefined
  if (!added.length) return failure('agy generated no image.', { conversationId, note: said })
  const now = new Date()
  const paths: string[] = []
  const previews: Preview[] = []
  for (const [i, entry] of added.entries()) {
    const extension = extensionOf(entry.name)
    const path = variantPath(request.out ? withExtension(request.out, extension) : `${deps.outDir}/${fileName(request.prompt, now, extension)}`, i, added.length)
    await deps.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/')) || '/'])
    const copied = await deps.run(['cp', `${dir}/${entry.name}`, path], { timeoutMs: 60_000 })
    if (copied.exitCode !== 0) return { ...failure(`Could not copy ${dir}/${entry.name} to ${path}: ${copied.stderr.trim()}`, { conversationId }), paths }
    paths.push(path)
    const preview = await previewOf(deps, path)
    if (preview) previews.push(preview)
  }
  const head = [`agy conversation ${conversationId}`, `model ${model ?? "agy's default"}`, 'image'].join(' · ')
  const record = `${deps.outDir}/${fileName(request.prompt, now)}`
  await deps.write(record, `<!-- ${head} -->\n\n${request.prompt}\n\n${paths.map(path => `- ${path}`).join('\n')}\n${message?.trim() ? `\n${message.trim()}\n` : ''}`)
  return imageSummary(conversationId, paths, previews, said)
}

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const

const isFinding = (value: unknown): value is Finding => {
  const f = value as Finding
  return (
    typeof value === 'object' &&
    value !== null &&
    PRIORITIES.includes(f.priority) &&
    typeof f.title === 'string' &&
    f.title.trim() !== '' &&
    typeof f.path === 'string' &&
    f.path.trim() !== '' &&
    Number.isInteger(f.line) &&
    f.line > 0 &&
    typeof f.detail === 'string'
  )
}

/**
 * A review's findings from its `structured_output`, most severe first (agy's order within one priority), each path
 * relative to the repository: agy runs in the review worktree `root` and may name a file by its path there. Undefined
 * when the output is not the shape `REVIEW_SCHEMA` asks for, so the review falls back to agy's text.
 */
export function findingsOf(structured: unknown, root?: string): Finding[] | undefined {
  const list = (structured as { findings?: unknown } | null)?.findings
  if (!Array.isArray(list) || !list.every(isFinding)) return undefined
  const prefix = root ? `${root.replace(/\/$/, '')}/` : undefined
  const relative = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path).replace(/^(?:\.\/)+/, '')
  return list
    .map(f => ({ priority: f.priority, title: f.title.trim(), path: relative(f.path.trim()), line: f.line, detail: f.detail.trim() }))
    .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority))
}

/** Findings as the review's Markdown: `[P1] title — path:line`, then the detail, or "No findings." for none. */
export function reviewMarkdown(findings: Finding[]): string {
  if (!findings.length) return 'No findings.'
  return findings.map(f => `[${f.priority}] ${f.title} — ${f.path}:${f.line}${f.detail ? `\n${f.detail}` : ''}`).join('\n\n')
}

/**
 * Saves an answer as Markdown, with the conversation, the model and (for a review) the target first and the plugin's
 * note before the answer, and says where. `model` is the one the run used: the request's, else the one agy picked. A
 * review with structured findings is written from them, and they are also saved as JSON in the answers folder (never
 * beside an `out` in the project); `root` is its worktree, whose prefix comes off their paths.
 */
export async function saveAnswer(deps: OutputDeps, result: RunResult, request: Request, model: string | undefined, root?: string): Promise<Outcome> {
  const { conversationId, message } = result
  if (result.error || !conversationId || message === undefined) {
    return failure(result.error ?? 'agy ended without an answer.', { conversationId, note: request.note, timedOut: result.timedOut, hint: !result.timedOut })
  }
  const path = request.out ?? `${deps.outDir}/${fileName(request.prompt, new Date())}`
  const head = [`agy conversation ${conversationId}`, `model ${model ?? "agy's default"}`, ...(request.kind === 'review' ? [request.prompt] : [])].join(' · ')
  const findings = request.kind === 'review' ? findingsOf(result.structured, root) : undefined
  const notes = [request.note, request.kind === 'review' && result.structured !== undefined && !findings ? NO_STRUCTURED_FINDINGS : undefined].filter(Boolean)
  const body = findings ? reviewMarkdown(findings) : message.trim()
  const markdown = notes.length ? `${notes.join('\n\n')}\n\n${body}` : body
  await deps.write(path, `<!-- ${head} -->\n\n${markdown}\n`)
  const outcome = askOutcome(conversationId, markdown, path, request.maxChars)
  if (!findings) return outcome
  const json = `${deps.outDir}/${path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')}.findings.json`
  await deps.write(json, `${JSON.stringify(findings, null, 2)}\n`)
  return withFindingsFile(outcome, json)
}
