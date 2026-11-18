// A stand-in agy for the tests: a shell script that answers `--version`, `models` and `-p /usage` the way agy 1.5.11
// does (shapes captured from the real CLI, values made up), runs tests/fake-acp.mjs for `agy acp`, or fails as
// FAKE_AGY_MODE says. Nothing reaches the network.
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const USAGE_JSON = {
  conversation_id: '',
  status: 'SUCCESS',
  response: '',
  command: {
    name: 'usage',
    data: {
      description: '',
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-11-25T09:00:00Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.25, reset_time: '2026-11-18T14:00:00Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-25T14:00:00Z' },
            { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.05, reset_time: '2026-11-18T19:00:00Z' },
          ],
        },
        { name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 0.08, reset_time: '2026-11-25T14:00:00Z' }] },
      ],
    },
  },
}

export const MODELS_TEXT = [
  'Fetching available models...',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  '',
].join('\n')

/** Writes the fake into a new folder and returns that folder, to put first on PATH. */
export async function fakeAgyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-agy-'))
  await writeFile(join(dir, 'models.txt'), MODELS_TEXT)
  await writeFile(join(dir, 'usage.json'), JSON.stringify(USAGE_JSON))
  const script = `#!/bin/sh
here=$(dirname "$0")
case "$FAKE_AGY_MODE" in
  signed-out) [ "$1" = models ] && { echo "Fetching available models..."; echo "not signed in" >&2; exit 1; } ;;
  broken) echo "boom" >&2; exit 1 ;;
esac
case "$1" in
  --version) echo "1.5.11" ;;
  models) cat "$here/models.txt" ;;
  acp) shift; exec '${process.execPath}' '${join(import.meta.dirname, 'fake-acp.mjs')}' "$@" ;;
  -p) [ "$2" = /usage ] && cat "$here/usage.json" || { echo "unexpected prompt" >&2; exit 9; } ;;
  *) echo "unexpected $*" >&2; exit 9 ;;
esac
`
  await writeFile(join(dir, 'agy'), script)
  await chmod(join(dir, 'agy'), 0o755)
  return dir
}
