// The inputs of the tools this plugin registers in session.start, in the shape the engine lays for connected MCP
// tools (.claude-plugin/types/claude-code-mcp), so `{ tool: 'mcp__antigravity__ask' }` matchers type `e` before a
// save regenerates that file. Each inputSchema in hooks/tool-schemas.ts satisfies SchemaFor of its entry here, so tsc
// fails when they differ.

/** The reasoning efforts `agy --effort` takes. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

declare module 'claude-code' {
  interface McpToolInputs {
    mcp__antigravity__ask: {
      prompt: string
      conversationId?: string
      model?: string
      effort?: Effort
      files?: string[]
      wait?: boolean
      out?: string
      maxChars?: number
    }
    mcp__antigravity__review: {
      base?: string
      commit?: string
      focus?: string
      model?: string
      effort?: Effort
      wait?: boolean
      out?: string
      maxChars?: number
    }
    mcp__antigravity__jobs: {}
  }
}
