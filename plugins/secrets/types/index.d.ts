// The plugin's type contract: what a request holds and the `$.state` values the pane draws. The tool's input lives
// with the MCP server (server/tool.ts), which Claude Code runs from .mcp.json.
export type SecretRequest = {
  name: string
  label: string
  reason: string
  steps: string[]
  url?: string
  format?: string
}

declare module 'claude-code' {
  interface PluginState {
    secrets: {
      /** The requests waiting for the user, oldest first; the first is the card drawn. */
      requests: SecretRequest[]
      /** True while the pane Claude opened waits undrawn for a wider terminal. */
      isWaiting: boolean
    }
  }
}
