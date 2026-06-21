import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexArgs } from '../src/adapters/codex.js'

test('read-only flags come strictly before the exec subcommand', () => {
  const args = buildCodexArgs({ hasCwd: false })
  const execIdx = args.indexOf('exec')
  assert.ok(execIdx > 0, 'exec must be present')

  const sandboxIdx = args.indexOf('--sandbox')
  const approvalIdx = args.indexOf('--ask-for-approval')
  assert.ok(sandboxIdx >= 0 && sandboxIdx < execIdx, '--sandbox before exec')
  assert.equal(args[sandboxIdx + 1], 'read-only')
  assert.ok(approvalIdx >= 0 && approvalIdx < execIdx, '--ask-for-approval before exec')
  assert.equal(args[approvalIdx + 1], 'never')
})

test('no -C when the session has no cwd', () => {
  const args = buildCodexArgs({ hasCwd: false })
  assert.ok(!args.includes('-C'))
})

test('-C <cwd> is added only when a cwd is set', () => {
  const args = buildCodexArgs({ hasCwd: true, cwd: '/tmp' })
  const i = args.indexOf('-C')
  assert.ok(i >= 0)
  assert.equal(args[i + 1], '/tmp')
})

test('prompt is read from stdin (trailing "-")', () => {
  const args = buildCodexArgs({ hasCwd: false })
  assert.equal(args[args.length - 1], '-')
})
