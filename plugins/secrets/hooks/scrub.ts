// The scrubber: the guarantee behind the fence. Any saved value that reaches a message, a tool
// result or a prompt is replaced with [secret:NAME] before the row is stored or sent.

/** Values shorter than this are not scrubbed: they would match ordinary words and numbers. */
export const MIN_LENGTH = 8

/** Longest first, so a value inside another is never cut out of it. */
export type Index = ReadonlyArray<readonly [value: string, name: string]>

export function buildIndex(values: ReadonlyMap<string, string>): Index {
  return [...values]
    .filter(([value]) => isScrubbable(value))
    .sort((a, b) => b[0].length - a[0].length)
}

export function isScrubbable(value: string): boolean {
  return value.length >= MIN_LENGTH && !/^(true|false|-?\d+(\.\d+)?)$/i.test(value)
}

export function scrub(text: string, index: Index): string {
  let out = text
  for (const [value, name] of index) {
    if (out.includes(value)) out = out.split(value).join(`[secret:${name}]`)
  }
  return out
}

export type Block = { type: string; [field: string]: unknown }

/** A content block with its text and tool result text scrubbed, or the same block when nothing matched. */
export function scrubBlock(block: Block, index: Index): Block {
  if (block.type === 'text' && typeof block.text === 'string') {
    const text = scrub(block.text, index)
    return text === block.text ? block : { ...block, text }
  }
  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      const content = scrub(block.content, index)
      return content === block.content ? block : { ...block, content }
    }
    if (Array.isArray(block.content)) {
      const parts = block.content as Block[]
      const content = parts.map((part) => scrubBlock(part, index))
      return content.every((part, i) => part === parts[i]) ? block : { ...block, content }
    }
  }
  return block
}

/** Whether any text in `input`, at any depth, holds one of the saved values long enough to be scrubbed. */
export function carries(input: unknown, values: Iterable<string>): boolean {
  const live = [...values].filter(isScrubbable)
  if (live.length === 0) return false
  const walk = (value: unknown): boolean => {
    if (typeof value === 'string') return live.some((secret) => value.includes(secret))
    if (Array.isArray(value)) return value.some(walk)
    if (value && typeof value === 'object') return Object.values(value).some(walk)
    return false
  }
  return walk(input)
}
