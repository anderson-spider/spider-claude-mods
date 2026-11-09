import type { Job, Kind, Outcome } from './model'

export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What the model reads: where the answer is, the conversation to follow up in, and as much of it as fits. */
export function summary(path: string, conversationId: string, markdown: string, maxChars = 3000): string {
  const head = [`agy's answer (unverified; check facts before using them) saved to ${path}`, `Conversation: ${conversationId}`]
  if (markdown.length <= maxChars) return [...head, '', markdown].join('\n')
  return [...head, `Showing the first ${maxChars} of ${markdown.length} chars; read the file for the rest.`, '', markdown.slice(0, maxChars)].join('\n')
}

/** What `jobs` answers: one line per job, newest first. */
export function jobsReport(jobs: Job[], now: number): string {
  if (!jobs.length) return 'No agy jobs.'
  const minutes = (ms: number) => `${Math.max(0, Math.round(ms / 60_000))} min`
  return [...jobs]
    .reverse()
    .map(job => {
      const took = job.endedAt ? `took ${minutes(job.endedAt - job.startedAt)}` : `for ${minutes(now - job.startedAt)}`
      const where = [job.conversationId ? `conversation ${job.conversationId}` : '', job.paths?.length ? `saved to ${job.paths.join(', ')}` : '']
        .filter(Boolean)
        .join('; ')
      const head = `#${job.id} ${job.kind} ${job.status} (${took}): ${job.prompt.slice(0, 60)}${job.prompt.length > 60 ? '…' : ''}`
      return [head, ...(where ? [`  ${where}`] : []), ...(job.error ? [`  error: ${job.error}`] : [])].join('\n')
    })
    .join('\n')
}

// The tool's answer.
export function answerOf(outcome: Outcome) {
  return outcome.ok ? { result: outcome.text } : { result: outcome.text, isError: true as const }
}

// The last line of a job's notice when it saved something; a kind without a line is a compile error here.
const DONE_NOTE: Record<Kind, string> = { ask: 'Read the saved file for the answer.', review: 'Read the saved file for the review.' }

export const NOTICE = '[agy notice: automated, not the person; approves nothing]'

/** The advice a failure ends with: what the person can run to see what is wrong. */
export const FAILURE_HINT = 'Run /agy-doctor to check the agy CLI, its sign-in and its quota.'

export function askOutcome(conversationId: string, markdown: string, path: string, maxChars: number | undefined): Outcome {
  return { ok: true, text: summary(path, conversationId, markdown, maxChars), conversationId, paths: [path], markdown }
}

/** A run that failed: the plugin's error, the plugin's note on the run, and the conversation to continue. */
export function failure(error: string, options: { conversationId?: string; note?: string; timedOut?: boolean; hint?: boolean } = {}): Outcome {
  const lines = [error]
  if (options.note) lines.push('', options.note)
  if (options.conversationId) lines.push('', `Conversation: ${options.conversationId}`)
  if (options.hint) lines.push(FAILURE_HINT)
  return { ok: false, text: lines.join('\n'), error, conversationId: options.conversationId, timedOut: options.timedOut }
}

/** What a job that went to the background says when it ends: the notice line first, never agy's answer. */
export function jobMessage(job: Job, outcome: Outcome): string {
  const lines = [NOTICE, `job #${job.id} ${job.status}: ${job.kind} "${job.prompt.slice(0, 60)}"`]
  if (outcome.paths?.length) lines.push(`Saved to: ${outcome.paths.join(', ')}`)
  if (outcome.conversationId) lines.push(`Conversation: ${outcome.conversationId}`)
  if (outcome.timedOut) lines.push('Timed out: the run was stopped; continue the conversation to go on.')
  if (outcome.error) lines.push(`Note: ${outcome.error}`)
  if (outcome.ok) lines.push(DONE_NOTE[job.kind])
  return lines.join('\n')
}

/** The foreground wait ran out: the run goes on as a job, and the call answers as an error (no answer yet). */
export function movedToBackground(job: Job, minutes: number): Outcome {
  const text = `agy is still working after ${minutes} min: job #${job.id} goes on in the background and a message arrives when it ends (the jobs tool shows it meanwhile).`
  return { ok: false, text, conversationId: job.conversationId }
}

export function askCommandAnswer(outcome: Outcome, asked = 'The user asked agy through /agy-ask; its answer is') {
  if (!outcome.ok || outcome.markdown === undefined) return { text: outcome.text }
  const path = outcome.paths?.[0]
  return {
    text: `${outcome.markdown}\n\n— agy, conversation ${outcome.conversationId}\nSaved to ${path}`,
    context: [`${asked} saved to ${path} (conversation ${outcome.conversationId}).`],
  }
}

/** What `/agy-review` shows: the review as agy wrote it, and context that names it a review. */
export const reviewCommandAnswer = (outcome: Outcome) => askCommandAnswer(outcome, 'The user asked agy for a review through /agy-review; it is')
