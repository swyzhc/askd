import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import {
  FORBIDDEN_TOOLS,
  FILE_TOOLS,
  allowedToolsFor,
  disallowedToolsFor,
  validateCwd,
  isInsideRoot,
  pathFromToolInput,
} from '../src/safety.js'

test('write and shell tools are never in the allow-list', () => {
  // The real guarantee: regardless of FORBIDDEN_TOOLS contents, no write/shell
  // tool (incl. the removed MultiEdit) is ever allowed, with or without a cwd.
  for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    assert.ok(!allowedToolsFor(true).includes(t), `${t} must not be allowed (cwd set)`)
    assert.ok(!allowedToolsFor(false).includes(t), `${t} must not be allowed (no cwd)`)
  }
})

test('the explicit deny list contains the current write/shell tools', () => {
  for (const t of ['Edit', 'Write', 'NotebookEdit', 'Bash']) {
    assert.ok(FORBIDDEN_TOOLS.includes(t), `${t} should be explicitly denied`)
  }
})

test('no cwd => web tools only, no file read tools', () => {
  const allowed = allowedToolsFor(false)
  assert.deepEqual(allowed, ['WebFetch', 'WebSearch'])
  for (const t of FILE_TOOLS) assert.ok(!allowed.includes(t))
})

test('cwd set => read-only file + web tools, never write/shell', () => {
  const allowed = allowedToolsFor(true)
  assert.deepEqual(allowed, ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
  for (const t of FORBIDDEN_TOOLS) assert.ok(!allowed.includes(t))
})

test('disallow list bans write/shell always; bans file tools when no cwd', () => {
  const noCwd = disallowedToolsFor(false)
  for (const t of FORBIDDEN_TOOLS) assert.ok(noCwd.includes(t))
  for (const t of FILE_TOOLS) assert.ok(noCwd.includes(t))

  const withCwd = disallowedToolsFor(true)
  for (const t of FORBIDDEN_TOOLS) assert.ok(withCwd.includes(t))
  for (const t of FILE_TOOLS) assert.ok(!withCwd.includes(t))
})

test('validateCwd rejects relative/missing, accepts a real directory', () => {
  assert.equal(validateCwd(null).ok, true)
  assert.equal(validateCwd(null).cwd, null)
  assert.equal(validateCwd('').cwd, null)
  assert.equal(validateCwd('relative/path').ok, false)
  assert.equal(validateCwd('/definitely/not/here/askd-xyz-123').ok, false)
  const r = validateCwd(tmpdir())
  assert.equal(r.ok, true)
})

test('isInsideRoot confines paths to the root', () => {
  const root = '/home/u/proj'
  assert.ok(isInsideRoot(root, '/home/u/proj'))
  assert.ok(isInsideRoot(root, '/home/u/proj/src/a.js'))
  assert.ok(!isInsideRoot(root, '/home/u/projX')) // sibling prefix must not match
  assert.ok(!isInsideRoot(root, '/home/u'))
  assert.ok(!isInsideRoot(root, '/etc/passwd'))
})

test('pathFromToolInput extracts the right field per tool', () => {
  assert.equal(pathFromToolInput('Read', { file_path: '/a/b' }), '/a/b')
  assert.equal(pathFromToolInput('Grep', { pattern: 'x', path: '/a' }), '/a')
  assert.equal(pathFromToolInput('Glob', { path: '/a' }), '/a')
  assert.equal(pathFromToolInput('WebFetch', { url: 'http://x' }), null)
  assert.equal(pathFromToolInput('Read', {}), null)
})
