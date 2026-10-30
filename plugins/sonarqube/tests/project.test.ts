import { expect, test } from 'claude-code/testing'
import { findProjectKey, foldersUp, parentOf, propertyKey } from '../hooks/project'

test('propertyKey reads sonar.projectKey with = or : and skips comments', () => {
  expect(propertyKey('sonar.projectKey=megazord\n')).toBe('megazord')
  expect(propertyKey('# sonar.projectKey=old\n! x\nsonar.projectName=M\r\nsonar.projectKey : app-api \n')).toBe('app-api')
  expect(propertyKey('sonar.projectKeys=no\nsonar.projectKey=\n')).toBeUndefined()
})

test('propertyKey follows Java properties: the last value wins, escapes are decoded, a backslash continues the line', () => {
  expect(propertyKey('sonar.projectKey=first\nsonar.projectKey=second\n')).toBe('second')
  expect(propertyKey('sonar.projectKey=first\nsonar.projectKey=\n')).toBeUndefined()
  expect(propertyKey('sonar.projectKey=app\\:backend\n')).toBe('app:backend')
  expect(propertyKey('sonar.projectKey=\\u0041pp\\=x\\\\y\n')).toBe('App=x\\y')
  expect(propertyKey('sonar\\.projectKey=escaped-key\n')).toBe('escaped-key')
  expect(propertyKey('sonar.projectKey   = spaced\n')).toBe('spaced')
  expect(propertyKey('sonar.projectKey whitespace-separated\n')).toBe('whitespace-separated')
  expect(propertyKey('sonar.projectKey=app-\\\n    api\n')).toBe('app-api')
  // an even run of backslashes is an escaped backslash, not a continuation
  expect(propertyKey('sonar.projectKey=a\\\\\nsonar.projectName=b\n')).toBe('a\\')
})

test('parentOf climbs posix and drive paths and stops at their top', () => {
  expect(parentOf('/repo/app')).toBe('/repo')
  expect(parentOf('/repo')).toBe('/')
  expect(parentOf('/')).toBeUndefined()
  expect(parentOf('C:\\repo')).toBe('C:\\')
  expect(parentOf('C:\\')).toBeUndefined()
})

test('foldersUp walks up to the folder holding .git, nearest first, and keeps only the start outside a working tree', async () => {
  const exists = (paths: string[]) => async (path: string) => paths.includes(path)

  expect(await foldersUp('/repo/app/src/', exists(['/repo/.git']))).toEqual(['/repo/app/src', '/repo/app', '/repo'])
  expect(await foldersUp('/repo', exists(['/repo/.git']))).toEqual(['/repo'])
  expect(await foldersUp('/tmp/x/y', exists([]))).toEqual(['/tmp/x/y'])
})

test('findProjectKey answers the nearest file with a key, and undefined when none has one', async () => {
  const files: Record<string, string> = {
    '/repo/app/sonar-project.properties': 'sonar.projectName=no key\n',
    '/repo/sonar-project.properties': 'sonar.projectKey=root-key\n',
  }
  const read: string[] = []
  const io = (cwd: string) => ({ cwd: async () => cwd, exists: async (path: string) => path === '/repo/.git', read: async (path: string) => (read.push(path), files[path]) })

  expect(await findProjectKey(io('/repo/app/src'))).toEqual({ key: 'root-key', file: '/repo/sonar-project.properties' })
  expect(read).toEqual(['/repo/app/src/sonar-project.properties', '/repo/app/sonar-project.properties', '/repo/sonar-project.properties'])
  expect(await findProjectKey(io('/other'))).toBeUndefined()
})
