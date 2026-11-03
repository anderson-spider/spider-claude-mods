import { extensionOf, fileName, variantPath } from './files'
import type { OutputDeps, Outcome, Preview, Request, RunResult } from './model'
import { askOutcome, failure, imageSummary } from './presentation'

// The longest side of the preview the image tool hands back with the file.
const PREVIEW_SIDE = 768

/** Where Codex saves the images of a session: `$CODEX_HOME/generated_images/<thread id>/`. */
export const imagesDir = (codexHome: string, threadId: string) => `${codexHome}/generated_images/${threadId}`

/** The names already in a session's image folder, so a follow-up hands back only the images it adds. */
export async function imagesBefore(deps: Pick<OutputDeps, 'list' | 'codexHome'>, threadId: string | undefined): Promise<Set<string>> {
  if (!threadId) return new Set()
  const entries = await deps.list(imagesDir(deps.codexHome, threadId)).catch(() => [])
  return new Set(entries.map(entry => entry.name))
}

// Where a request's file goes: its `out` when it names one, else a fresh name in the output folder.
const outPath = (deps: Pick<OutputDeps, 'outDir'>, request: Request, extension: string, now = new Date()) =>
  request.out ?? `${deps.outDir}/${fileName(request.prompt, now, extension)}`

/** Saves an answer as Markdown, its thread first, and says where. */
export async function saveAnswer(deps: OutputDeps, result: RunResult, request: Request): Promise<Outcome> {
  const { threadId, message } = result
  if (result.error || !threadId || message === undefined) {
    return failure(result.error ?? 'Codex ended without an answer.', { threadId, said: message, timedOut: result.timedOut, hint: !result.timedOut })
  }
  const path = outPath(deps, request, 'md')
  const markdown = request.note ? `${request.note}\n\n${message}` : message
  await deps.write(path, `<!-- codex thread ${threadId} -->\n\n${markdown}\n`)
  return askOutcome(threadId, markdown, path, request.maxChars)
}

// A small JPEG of the saved image (sips, on macOS), so the model sees it at once.
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

/** Copies the images the run added to its session's folder into the output folder, oldest first, with previews. */
export async function saveImages(deps: OutputDeps, result: RunResult, request: Request, before: Set<string>): Promise<Outcome> {
  const { threadId, message } = result
  if (result.error || !threadId) {
    return failure(result.error ?? 'Codex ended without a session.', { threadId, said: message, timedOut: result.timedOut, hint: !result.timedOut })
  }
  const dir = imagesDir(deps.codexHome, threadId)
  const added = (await deps.list(dir).catch(() => []))
    .filter(entry => entry.kind === 'file' && !before.has(entry.name))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
  if (!added.length) return failure('Codex generated no image.', { threadId, said: message })
  const paths: string[] = []
  const previews: Preview[] = []
  const now = new Date()
  for (const [i, entry] of added.entries()) {
    const path = variantPath(outPath(deps, request, extensionOf(entry.name), now), i, added.length)
    const folder = path.slice(0, path.lastIndexOf('/')) || '/'
    await deps.run(['mkdir', '-p', folder])
    const copied = await deps.run(['cp', `${dir}/${entry.name}`, path], { timeoutMs: 60_000 })
    if (copied.exitCode !== 0) return { ...failure(`Could not copy ${dir}/${entry.name} to ${path}: ${copied.stderr.trim()}`, { threadId }), paths }
    paths.push(path)
    const preview = await previewOf(deps, path)
    if (preview) previews.push(preview)
  }
  return imageSummary(threadId, paths, previews, message)
}
