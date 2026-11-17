// The plugin's type contract. Its tools come from the MCP server (server/main.mjs), whose inputs are typed in
// hooks/tool-schemas.ts, so nothing here extends the engine's types.

/** The reasoning efforts `agy --effort` takes. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
