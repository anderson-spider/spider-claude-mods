// The inputs of the tools this plugin registers, in the shape the engine lays for
// connected MCP tools (.claude-plugin/types/claude-code-mcp), so
// `{ tool: 'mcp__codex__ask' }` matchers type `e` before a save regenerates that
// file. Each inputSchema in hooks/tool-schemas.ts satisfies SchemaFor of its
// entry here, so tsc fails when they differ; hooks/computer-use/prompts.ts checks
// the computer use tool's keys against its `inputSchema` instead.

/** An app-approval question waiting for the person, drawn above the prompt. */
export type CodexAsking = {
  id: string
  bundleId: string
  displayName: string
  /** Codex offers "always" for this app. */
  canAlways: boolean
  /** Who asked: `main session` or `subagent <id>`. */
  who: string
}

/** The input of the computer use tool, registered in session.start on macOS. */
export type CodexCuInput = {
  code?: string
  title?: string
  timeout_ms?: number
  reset?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    codex: { asking: CodexAsking | null }
  }

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
    mcp__codex__review: {
      base?: string
      commit?: string
      uncommitted?: boolean
      instructions?: string
      model?: string
      effort?: string
      wait?: boolean
      out?: string
      maxChars?: number
    }
    mcp__codex__jobs: {}
    mcp__codex__computer_use: CodexCuInput
  }
}
