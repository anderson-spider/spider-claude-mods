import { expect, test } from 'claude-code/testing'
import { defaultsOf, diagnose, report } from '../hooks/doctor'

const ran = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr })

test('the defaults are the top-level model and effort, never a table\'s', () => {
  expect(defaultsOf('model = "gpt-6.1"\nmodel_reasoning_effort = "max"\n[profiles.x]\nmodel = "other"\n')).toEqual({ model: 'gpt-6.1', effort: 'max' })
  expect(defaultsOf('[tui]\nmodel = "other"\n')).toEqual({ model: undefined, effort: undefined })
})

test('the doctor reports the executable, its version, its login and the defaults', async () => {
  const runs: string[][] = []
  const checks = await diagnose({
    codex: '/bin/codex',
    run: async argv => (runs.push(argv), argv[1] === '--version' ? ran(0, 'codex-cli 0.166.0\n') : ran(1, '', 'Not logged in\n')),
    config: async () => 'model = "gpt-6.1"\n',
    configPath: '/h/.codex/config.toml',
  })
  expect(runs).toEqual([['/bin/codex', '--version'], ['/bin/codex', 'login', 'status']])
  expect(report(checks)).toBe([
    '✓ codex: /bin/codex',
    '✓ version: codex-cli 0.166.0',
    '✗ login: Not logged in',
    "✓ defaults: model gpt-6.1, effort Codex's default (/h/.codex/config.toml); a call's model and effort override them",
    'Sign in with `! codex login`.',
  ].join('\n'))
})

test('without an executable the doctor stops at once', async () => {
  const checks = await diagnose({ codex: { error: 'not found' }, run: async () => ran(0), config: async () => undefined, configPath: '/c' })
  expect(report(checks)).toBe('✗ codex: not found')
})
