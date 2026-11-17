// The notices the daemon leaves for a session when its tasks end: one JSON file `{ taskId, text }` each. Pure.

export type Notice = { taskId: string; text: string }

/** A notice file's content, or undefined when it is not one. */
export function noticeOf(json: string): Notice | undefined {
  try {
    const value = JSON.parse(json) as Partial<Notice>
    return typeof value.taskId === 'string' && typeof value.text === 'string' && value.text.trim() ? { taskId: value.taskId, text: value.text } : undefined
  } catch {
    return undefined
  }
}
