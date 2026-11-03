// The inputs of the tools this plugin registers, in the shape the engine lays for
// connected MCP tools (.claude-plugin/types/claude-code-mcp), so
// `{ tool: 'mcp__codex__ask' }` matchers type `e` before a save regenerates that
// file. Each inputSchema in TOOLS (hooks/tool-schemas.ts) satisfies SchemaFor of its
// entry here, so tsc fails when they differ.
export {}
declare module 'claude-code' {
  interface McpToolInputs {
    mcp__codex__ask: {
      prompt: string
      threadId?: string
      model?: string
      effort?: string
      files?: string[]
      wait?: boolean
      out?: string
      maxChars?: number
    }
    mcp__codex__image: {
      prompt: string
      reference?: string
      threadId?: string
      model?: string
      effort?: string
      files?: string[]
      wait?: boolean
      out?: string
    }
    mcp__codex__jobs: {}
  }
}
