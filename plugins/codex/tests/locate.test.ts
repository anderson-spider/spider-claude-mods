import { expect, test } from 'claude-code/testing'
import { NOT_FOUND, locateCodex } from '../hooks/locate'

const only = (...paths: string[]) => async (path: string) => paths.includes(path)

test('the configured path wins when it exists, and is an error when it does not', async () => {
  expect(await locateCodex('/opt/codex', { exists: only('/opt/codex', '/usr/bin/codex'), path: '/usr/bin' })).toBe('/opt/codex')
  expect(await locateCodex('/opt/codex', { exists: only() })).toEqual({ error: 'The codexPath option names /opt/codex, which does not exist.' })
})

test('PATH comes first, then the folders the installers use, ~ being HOME', async () => {
  expect(await locateCodex(undefined, { exists: only('/usr/local/bin/codex', '/bin/codex'), path: 'relative:/bin', home: '/h' })).toBe('/bin/codex')
  expect(await locateCodex(undefined, { exists: only('/usr/local/bin/codex', '/h/.local/bin/codex'), path: '/usr/bin', home: '/h' })).toBe('/h/.local/bin/codex')
  expect(await locateCodex(undefined, { exists: only('/h/.local/bin/codex'), path: '/usr/bin' })).toEqual({ error: NOT_FOUND })
})
