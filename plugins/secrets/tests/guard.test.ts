import { expect, test } from 'claude-code/testing'
import { DENY, ancestors, bashReason, denyText, fenceReason, forms, toolReason } from '../hooks/guard'

const HOME = '/home/me'
const DIR = '/home/me/.claude/secrets'
const FILE = `${DIR}/TOK.0123456789abcdef`
const spellings = forms(DIR, HOME)

test('forms lists the absolute folder and its ~, $HOME and ${HOME} spellings under home', () => {
  expect(spellings).toEqual([DIR, '~/.claude/secrets', '$HOME/.claude/secrets', '${HOME}/.claude/secrets'])
  expect(forms('/cfg/secrets', HOME)).toEqual(['/cfg/secrets'])
})

test('a file read by a command substitution is the one way to use a secret', () => {
  for (const command of [
    `TOKEN="$(cat ${FILE})" wrangler deploy`,
    `curl -H "Authorization: Bearer $(cat ${FILE})" https://api.example.com`,
    `adb pair 10.0.0.2:4000 "$(cat '${FILE}')"`,
    `sudo -S true <<< "$(cat ~/.claude/secrets/TOK.0123456789abcdef)"`,
    `echo $(< $HOME/.claude/secrets/TOK.0123456789abcdef) | wc -c`,
    'ls -la && git status',
  ]) {
    expect(bashReason(command, spellings)).toBeUndefined()
  }
})

test('every other way to touch the folder is refused, in any spelling', () => {
  for (const command of [
    `cat ${FILE}`,
    `cat ~/.claude/secrets/TOK.0123456789abcdef`,
    `echo $HOME/.claude/secrets/TOK.0123456789abcdef`,
    `ls ${DIR}`,
    `grep -r . ${DIR}`,
    `cp ${FILE} /tmp/x`,
    `cat .claude/secrets/TOK.0123456789abcdef`,
    `cat $CLAUDE_CONFIG_DIR/secrets/TOK.0123456789abcdef`,
    // a safe use does not excuse a second, bare one
    `TOKEN="$(cat ${FILE})" && cat ${FILE}`,
  ]) {
    expect(bashReason(command, spellings)).toBe('it touches the secrets folder')
  }
})

test('tracing a command that uses a secret is refused, since it would print the value', () => {
  for (const command of [`set -x; TOKEN="$(cat ${FILE})" cli`, `bash -x -c 'TOKEN="$(cat ${FILE})" cli'`]) {
    expect(bashReason(command, spellings)).toBe('it traces the command, which would print the value')
  }
  expect(bashReason('set -x; ls', spellings)).toBeUndefined()
})

test('file tools are refused inside the folder, however the path is spelled', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'MultiEdit']) {
    expect(toolReason(tool, { file_path: FILE }, DIR, HOME, '/proj')).toBe(`it opens ${FILE}`)
  }
  expect(toolReason('Read', { file_path: '~/.claude/secrets/T.0123456789abcdef' }, DIR, HOME, '/proj')).toContain('it opens')
  expect(toolReason('Read', { file_path: '/proj/../home/me/.claude/./secrets/x' }, DIR, HOME, '/proj')).toContain('it opens')
  expect(toolReason('NotebookEdit', { notebook_path: `${DIR}/n.ipynb` }, DIR, HOME, '/proj')).toContain('it opens')
  expect(toolReason('Read', { file_path: '/home/me/.claude/settings.json' }, DIR, HOME, '/proj')).toBeUndefined()
  expect(toolReason('Read', { file_path: '/home/me/.claude/secrets-notes.md' }, DIR, HOME, '/proj')).toBeUndefined()
})

test('a search rooted at the folder or above it is refused, one below the project is not', () => {
  for (const path of [DIR, '/home/me/.claude', '/home/me', '/', '~/.claude']) {
    expect(toolReason('Grep', { path }, DIR, HOME, '/proj')).toBe(`it searches ${path}`)
    expect(toolReason('Glob', { path }, DIR, HOME, '/proj')).toBe(`it searches ${path}`)
  }
  expect(toolReason('Grep', { path: '/proj/src' }, DIR, HOME, '/proj')).toBeUndefined()
  expect(toolReason('Grep', { pattern: 'x' }, DIR, HOME, '/proj')).toBeUndefined()
  expect(toolReason('Glob', { pattern: `${DIR}/*` }, DIR, HOME, '/proj')).toContain('its pattern reaches')
  expect(toolReason('Glob', { pattern: '**/*.ts' }, DIR, HOME, '/proj')).toBeUndefined()
})

test('other tools are not the fence\'s business', () => {
  expect(toolReason('WebFetch', { url: FILE }, DIR, HOME, '/proj')).toBeUndefined()
})

test('ancestors lists each folder above the secrets folder, spelled every way under home', () => {
  expect(ancestors(DIR, HOME)).toEqual([
    '/home/me/.claude', '~/.claude', '$HOME/.claude', '${HOME}/.claude',
    '/home/me', '~', '$HOME', '${HOME}',
    '/home',
    '/',
  ])
})

test('a recursive search from a folder above the secrets folder is refused, one elsewhere is not', () => {
  const above = ancestors(DIR, HOME)
  for (const command of [
    'grep -r token ~/.claude',
    'grep -rn token $HOME',
    'grep --recursive x "/home/me/.claude/"',
    'rg token ~',
    'find / -name "*.env"',
    'find $HOME -type f -exec cat {} +',
    'ls -R ~/.claude',
    'cd /tmp && ugrep -r x /home/me',
  ]) {
    expect(bashReason(command, spellings, above)).toBe('it searches a folder that holds the secrets folder')
  }
  for (const command of [
    'grep -r token src',
    'grep -r token ./src ~/projects/app',
    'find . -name "*.ts"',
    'ls ~/.claude',
    'cat ~/.claude/settings.json',
    'echo ~',
    'rg token /home/me/other',
  ]) {
    expect(bashReason(command, spellings, above)).toBeUndefined()
  }
})

test('fenceReason checks a Bash command by its text and the other tools by their paths', () => {
  expect(fenceReason('Bash', { command: `cat ${FILE}` }, DIR, HOME, '/proj')).toBe('it touches the secrets folder')
  expect(fenceReason('Read', { file_path: FILE }, DIR, HOME, '/proj')).toBe(`it opens ${FILE}`)
  expect(fenceReason('Bash', { command: `TOKEN="$(cat ${FILE})" wrangler deploy` }, DIR, HOME, '/proj')).toBeUndefined()
  expect(fenceReason('SendMessage', { to: 'helper', message: 'deploy is done' }, DIR, HOME, '/proj')).toBeUndefined()
  expect(denyText('it opens x')).toBe(`${DENY} (Blocked because it opens x.)`)
  expect(DENY).toContain('mcp__plugin_secrets_secrets__request_secret')
})
