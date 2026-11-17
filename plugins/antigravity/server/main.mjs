// The antigravity MCP server: started by Claude Code from .mcp.json, as a child of the Claude Code process, with the
// plugin's options in its environment. It serves the four tools from the same pure modules the hooks module runs
// (hooks/service.ts), on Node.
// The Node side is plain JavaScript typed by JSDoc (tsconfig.node.json checks it): `claude plugin validate` reads the
// TypeScript a plugin runs as hooks-module code, which has no Node.
import { registerHooks } from 'node:module'

// The modules in hooks/ import each other without an extension, as the hooks engine resolves them; Node needs one, so
// a relative import that does not resolve is tried again with `.ts`.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})

// Imported once the hook is in place: a static import resolves before this module runs.
const { start } = await import('./serve.mjs')
start()
