import type { Entry, OutputDeps, Outcome, Preview, Request, RunResult } from './model'
import { askOutcome, failure, imageSummary } from './presentation'

// The longest side of the preview an image request hands back with its files.
const PREVIEW_SIDE = 768

// The images agy's image-generator subagent saves, by extension.
const IMAGE = /\.(png|jpe?g|webp|gif)$/i

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
export const artifactsOf = (deps: Pick<OutputDeps, 'brainDir'>, conversationId: string) => `${deps.brainDir}/${conversationId}`

// The images in a conversation's artifacts folder (its top level only), oldest first; none when it is missing.
async function imagesIn(deps: Pick<OutputDeps, 'list'>, dir: string): Promise<Entry[]> {
  const entries = await deps.list(dir).catch(() => [])
  return entries.filter(entry => entry.kind === 'file' && IMAGE.test(entry.name)).sort((a, b) => a.mtimeMs - b.mtimeMs)
}

/** The image names already in a conversation's artifacts folder, so a follow-up saves only the images it adds. */
export async function imagesBefore(deps: Pick<OutputDeps, 'list' | 'brainDir'>, conversationId: string | undefined): Promise<string[]> {
  return conversationId ? (await imagesIn(deps, artifactsOf(deps, conversationId))).map(entry => entry.name) : []
}

/** Adds a number to a path only when the run saved more than one image. */
export const variantPath = (base: string, index: number, count: number) => (count > 1 ? base.replace(/(\.\w+)?$/, `-${index + 1}$1`) : base)

const extensionOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

// A small JPEG of a saved image (sips, on macOS), so the model sees it at once; none elsewhere.
async function previewOf(deps: Pick<OutputDeps, 'run' | 'readBytes'>, path: string): Promise<Preview | undefined> {
  const small = `${path}.preview.jpg`
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
 * and saves a Markdown record of the request beside the first. agy's stream names no image, so the folder decides.
 */
export async function saveImages(deps: OutputDeps, result: RunResult, request: Request, before: string[], model: string | undefined): Promise<Outcome> {
  const { conversationId, message } = result
  if (result.error || !conversationId) {
    return failure(result.error ?? 'agy ended without a conversation.', { conversationId, timedOut: result.timedOut, hint: !result.timedOut })
  }
  const dir = artifactsOf(deps, conversationId)
  const added = (await imagesIn(deps, dir)).filter(entry => !before.includes(entry.name))
  const said = message?.trim() ? `agy said: ${message.trim()}` : undefined
  if (!added.length) return failure('agy generated no image.', { conversationId, note: said })
  const now = new Date()
  const paths: string[] = []
  const previews: Preview[] = []
  for (const [i, entry] of added.entries()) {
    const path = variantPath(request.out ?? `${deps.outDir}/${fileName(request.prompt, now, extensionOf(entry.name))}`, i, added.length)
    await deps.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/')) || '/'])
    const copied = await deps.run(['cp', `${dir}/${entry.name}`, path], { timeoutMs: 60_000 })
    if (copied.exitCode !== 0) return { ...failure(`Could not copy ${dir}/${entry.name} to ${path}: ${copied.stderr.trim()}`, { conversationId }), paths }
    paths.push(path)
    const preview = await previewOf(deps, path)
    if (preview) previews.push(preview)
  }
  const head = [`agy conversation ${conversationId}`, `model ${model ?? "agy's default"}`, 'image'].join(' · ')
  const record = paths[0]!.replace(/(\.\w+)?$/, '.md')
  await deps.write(record, `<!-- ${head} -->\n\n${request.prompt}\n\n${paths.map(path => `- ${path}`).join('\n')}\n${message?.trim() ? `\n${message.trim()}\n` : ''}`)
  return imageSummary(conversationId, paths, previews, said)
}

/**
 * Saves an answer as Markdown, with the conversation, the model and (for a review) the target first and the plugin's
 * note before the answer, and says where. `model` is the one the run used: the request's, else the one agy picked.
 */
export async function saveAnswer(deps: OutputDeps, result: RunResult, request: Request, model: string | undefined): Promise<Outcome> {
  const { conversationId, message } = result
  if (result.error || !conversationId || message === undefined) {
    return failure(result.error ?? 'agy ended without an answer.', { conversationId, note: request.note, timedOut: result.timedOut, hint: !result.timedOut })
  }
  const path = request.out ?? `${deps.outDir}/${fileName(request.prompt, new Date())}`
  const head = [`agy conversation ${conversationId}`, `model ${model ?? "agy's default"}`, ...(request.kind === 'review' ? [request.prompt] : [])].join(' · ')
  const markdown = request.note ? `${request.note}\n\n${message.trim()}` : message.trim()
  await deps.write(path, `<!-- ${head} -->\n\n${markdown}\n`)
  return askOutcome(conversationId, markdown, path, request.maxChars)
}
