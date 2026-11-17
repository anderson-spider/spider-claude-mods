// Where the orchestrator keeps its state, shared by the daemon (Node imports this file as is) and the hooks module.
// Pure: no Node and no engine.

/** The folder under the state home that holds the daemon's socket, its tasks and the notices waiting for a session. */
export const STATE_FOLDER = 'spider-orchestrator'

/** A Claude Code session id as it names a notice folder: no separator, so it never leaves the inbox. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The state folder: `$XDG_STATE_HOME` when it is absolute, else `~/.local/state`, then STATE_FOLDER. */
export function stateDirOf(home: string, xdgStateHome?: string): string {
  const base = xdgStateHome && xdgStateHome.startsWith('/') ? xdgStateHome.replace(/\/+$/, '') : `${home}/.local/state`
  return `${base}/${STATE_FOLDER}`
}

/** The folder of the notices waiting for one session: one JSON file a finished task, which its hooks module submits. */
export const inboxDirOf = (stateDir: string, sessionId: string) => `${stateDir}/inbox/${sessionId}`
