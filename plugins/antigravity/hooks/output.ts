import type { OutputDeps, Outcome, Request, RunResult } from './model'
import { askOutcome, failure } from './presentation'

/** A file name for an answer: timestamp plus a slug of the prompt. */
export function fileName(prompt: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const slug = prompt
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '')
  return `${stamp}-${slug || 'answer'}.md`
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
