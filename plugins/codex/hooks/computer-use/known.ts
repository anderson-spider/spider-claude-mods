// What this module instance has learned about the machine and the /codex-cu switch, for the hooks that cannot read
// them: the guard's `.catch` runs where `$` calls reject, and the hooks of a feature Linux never registers should do
// nothing there. Written by register.tsx (the platform at session.start, the switch at every read and write). Pure.

export type Known = {
  /** Whether `uname -s` said macOS; `undefined` until session.start has asked. */
  mac: boolean | undefined
  /** The switch as last read or set; `undefined` until then. */
  enabled: boolean | undefined
}

export const known: Known = { mac: undefined, enabled: undefined }

/** Whether computer use is ruled out here: session.start found another system. */
export const offMac = () => known.mac === false
