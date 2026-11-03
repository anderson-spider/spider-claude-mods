// What goes where: the model's own desktop computer-use tools are refused
// while the mod is on, browsers and purpose-built tools are left alone, and
// native app control goes through the bridge tool. Pure.

export const BRIDGE = 'computer_use'
/** The bridge tool as the engine names it (`mcp__<plugin>__<tool>`); the `tool.call` matcher in register.tsx spells it literally. */
export const TOOL = 'mcp__codex__computer_use'
/** How long an app stays with the caller that last used it; helper/lib/hub.mjs `LEASE_MS` is the same time, pinned by helper/test/contract.mjs. */
export const LEASE_MINUTES = 2

/**
 * Claude's own desktop control: the desktop app's computer-use server, the
 * remote-devices computer tools and the switch that turns them on. The
 * remote-devices browser (`mcp__remote-devices__Claude_Browser__*`) is not one.
 */
const OWN_DESKTOP = /^(mcp__computer-use__|mcp__remote-devices__computer|enable__mcp__remote-devices__computer)/

export const isOwnDesktopTool = (tool: string) => OWN_DESKTOP.test(tool)

/** The `$.store` key of the /codex-cu switch: off until the person turns it on, then held across sessions. */
export const ENABLED = 'computer-use:enabled'

/** Whether the stored switch value means on; anything but `true` (never set, a failed write) is off. */
export const isOn = (stored: unknown) => stored === true

/** How session.start tells macOS apart: computer use drives native Mac apps and is registered nowhere else. */
export const UNAME = ['uname', '-s']

/** Whether `uname -s` printed macOS's kernel name. */
export const isMac = (stdout: string) => stdout.trim() === 'Darwin'

/** App approval deadline, counted from before a question enters the queue. */
export const APPROVAL_MS = 5 * 60_000
