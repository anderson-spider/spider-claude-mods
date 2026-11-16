// The plugin's type contract: what a request holds, the `$.state` values the pane draws, and the
// input of the one tool it registers in session.start (the shape the engine lays for connected
// MCP tools, so `{ tool: 'mcp__secrets__request_secret' }` matchers type `e` before a save
// regenerates that file). Keep the inputs in step with the inputSchema in hooks/register.tsx.
export type SecretRequest = {
  name: string
  label: string
  reason: string
  steps: string[]
  url?: string
  format?: string
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__secrets__request_secret': {
      name: string
      label: string
      reason?: string
      steps?: string[]
      url?: string
      format?: string
    }
  }
  interface PluginState {
    secrets: {
      /** The requests waiting for the user, oldest first; the first is the card drawn. */
      requests: SecretRequest[]
      /** True while the pane Claude opened waits undrawn for a wider terminal. */
      isWaiting: boolean
    }
  }
}
