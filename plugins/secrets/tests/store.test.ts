import { expect, test } from 'claude-code/testing'
import { NAME } from '../hooks/request'
import { TTL_MS, fileName, isExpired, nameOf, randomSuffix, secretsDir, writeArgv } from '../hooks/store'

test('secretsDir sits beside the settings: CLAUDE_CONFIG_DIR first, else ~/.claude', () => {
  expect(secretsDir({ home: '/home/me' })).toBe('/home/me/.claude/secrets')
  expect(secretsDir({ home: '/home/me/', configDir: '/cfg/claude/' })).toBe('/cfg/claude/secrets')
  expect(secretsDir({})).toBeUndefined()
})

test('a file name is the secret name and a random suffix, and only those read back', () => {
  const file = fileName('CF_TOKEN', '0123456789abcdef')

  expect(file).toBe('CF_TOKEN.0123456789abcdef')
  expect(nameOf(file)).toBe('CF_TOKEN')
  expect(nameOf('CF_TOKEN.0123456789abcdef.partial')).toBeUndefined()
  expect(nameOf('notes.txt')).toBeUndefined()
  expect(nameOf('.hidden.0123456789abcdef')).toBeUndefined()
})

test('randomSuffix is 16 hex digits and differs between calls', () => {
  expect(randomSuffix()).toMatch(/^[0-9a-f]{16}$/)
  expect(randomSuffix()).not.toBe(randomSuffix())
})

test('a name starts with a letter or underscore and holds letters, digits and _ . -', () => {
  for (const ok of ['A', 'cf_token', 'API.KEY-2', '_x']) expect(NAME.test(ok)).toBe(true)
  for (const bad of ['', '1abc', 'a b', 'a/b', '../x', 'x'.repeat(65)]) expect(NAME.test(bad)).toBe(false)
})

test('a file expires strictly after a day', () => {
  expect(isExpired(0, TTL_MS)).toBe(false)
  expect(isExpired(0, TTL_MS + 1)).toBe(true)
})

test('writeArgv sends the folder and the file as arguments and never the value', () => {
  const argv = writeArgv('/h/.claude/secrets', 'T.0123456789abcdef')

  expect(argv.slice(0, 2)).toEqual(['sh', '-c'])
  expect(argv.slice(3)).toEqual(['sh', '/h/.claude/secrets', '/h/.claude/secrets/T.0123456789abcdef'])
  // owner-only from the first byte, refuses to overwrite, shows the file only once whole
  expect(argv[2]).toContain('umask 077')
  expect(argv[2]).toContain('set -C')
  expect(argv[2]).toContain('mv "$2.partial" "$2"')
})
