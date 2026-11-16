import { expect, test } from 'claude-code/testing'
import { buildIndex, isScrubbable, scrub, scrubBlock } from '../hooks/scrub'

const index = buildIndex(
  new Map([
    ['sk_live_abcdef123456', 'STRIPE_KEY'],
    ['sk_live_abcdef123456-extra', 'STRIPE_KEY_LONG'],
    ['short', 'SHORT'],
    ['12345678', 'NUMBER'],
    ['true', 'FLAG'],
  ]),
)

test('only values of 8 characters or more that are not a number or a boolean are scrubbed', () => {
  expect(isScrubbable('sk_live_abcdef123456')).toBe(true)
  for (const value of ['short', '12345678', '-1.5', 'TRUE', '']) expect(isScrubbable(value)).toBe(false)
  expect(index.map(([, name]) => name)).toEqual(['STRIPE_KEY_LONG', 'STRIPE_KEY'])
})

test('a value becomes [secret:NAME], the longest first so one inside another is never cut out of it', () => {
  expect(scrub('key=sk_live_abcdef123456-extra!', index)).toBe('key=[secret:STRIPE_KEY_LONG]!')
  expect(scrub('a sk_live_abcdef123456 b sk_live_abcdef123456', index)).toBe('a [secret:STRIPE_KEY] b [secret:STRIPE_KEY]')
  expect(scrub('nothing here, short 12345678', index)).toBe('nothing here, short 12345678')
})

test('scrubBlock rewrites text and tool result blocks, nested ones too, and leaves the rest as the same objects', () => {
  const clean = { type: 'text', text: 'hello' }
  const image = { type: 'image', source: 'sk_live_abcdef123456' }

  expect(scrubBlock(clean, index)).toBe(clean)
  expect(scrubBlock(image, index)).toBe(image)
  expect(scrubBlock({ type: 'text', text: 'is sk_live_abcdef123456' }, index)).toEqual({ type: 'text', text: 'is [secret:STRIPE_KEY]' })
  expect(scrubBlock({ type: 'tool_result', tool_use_id: 't', content: 'out sk_live_abcdef123456' }, index)).toEqual({
    type: 'tool_result',
    tool_use_id: 't',
    content: 'out [secret:STRIPE_KEY]',
  })
  expect(
    scrubBlock({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'x sk_live_abcdef123456' }, image] }, index),
  ).toEqual({
    type: 'tool_result',
    tool_use_id: 't',
    content: [{ type: 'text', text: 'x [secret:STRIPE_KEY]' }, image],
  })
  const same = { type: 'tool_result', tool_use_id: 't', content: [clean] }
  expect(scrubBlock(same, index)).toBe(same)
})
