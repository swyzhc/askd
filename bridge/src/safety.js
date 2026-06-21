// Centralized read-only security policy for the Claude backend.
//
// This module is the single source of truth for "what askd is allowed to do".
// The Claude adapter builds its SDK options from these constants, and
// test/safety.test.js asserts the invariants directly so a regression that
// re-enables a write tool fails the suite.
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

// Never available, in any mode. Writing files or running shells is out of scope
// for v1 — askd only reads.
export const FORBIDDEN_TOOLS = Object.freeze([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
])

// Local filesystem read tools. Only available when a session has an explicit
// cwd (local code root).
export const FILE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep'])

// Web tools. Always available — they don't touch the local filesystem.
export const WEB_TOOLS = Object.freeze(['WebFetch', 'WebSearch'])

// The complete read-only allow-list when a cwd is configured.
export const READONLY_TOOLS = Object.freeze([...FILE_TOOLS, ...WEB_TOOLS])

/**
 * The tools Claude may use for a session.
 * @param {boolean} hasCwd whether the session has a local code root
 * @returns {string[]} web-only when no cwd; read-only file+web tools when cwd set
 */
export function allowedToolsFor(hasCwd) {
  return hasCwd ? [...READONLY_TOOLS] : [...WEB_TOOLS]
}

/**
 * Tools to explicitly disallow. Always includes the forbidden write/shell
 * tools; also strips file tools when there is no cwd, so a session with no
 * local access has no path to the filesystem even via a stray tool reference.
 * @param {boolean} hasCwd
 * @returns {string[]}
 */
export function disallowedToolsFor(hasCwd) {
  return hasCwd
    ? [...FORBIDDEN_TOOLS]
    : [...FORBIDDEN_TOOLS, ...FILE_TOOLS]
}

/**
 * Validate a user-supplied cwd. Must be absolute, exist, and be a directory.
 * @param {unknown} cwd
 * @returns {{ ok: true, cwd: string } | { ok: false, error: string }}
 */
export function validateCwd(cwd) {
  if (cwd === null || cwd === undefined || cwd === '') {
    return { ok: true, cwd: null }
  }
  if (typeof cwd !== 'string') {
    return { ok: false, error: 'cwd must be a string path' }
  }
  if (!isAbsolute(cwd)) {
    return { ok: false, error: 'cwd must be an absolute path' }
  }
  let st
  try {
    st = statSync(cwd)
  } catch {
    return { ok: false, error: `cwd does not exist: ${cwd}` }
  }
  if (!st.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${cwd}` }
  }
  return { ok: true, cwd: resolve(cwd) }
}

/**
 * Is `target` the root directory itself or strictly inside it?
 * @param {string} root absolute, resolved directory
 * @param {string} target absolute, resolved path
 * @returns {boolean}
 */
export function isInsideRoot(root, target) {
  if (target === root) return true
  const base = root.endsWith(sep) ? root : root + sep
  return target.startsWith(base)
}

/**
 * Extract the filesystem path argument a read tool is about to touch, if any.
 * Used as a defense-in-depth check that file tools stay within the session root.
 * @param {string} toolName
 * @param {Record<string, unknown>} input
 * @returns {string | null}
 */
export function pathFromToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return null
  const candidate =
    toolName === 'Read'
      ? input.file_path
      : toolName === 'Grep' || toolName === 'Glob'
        ? input.path
        : null
  return typeof candidate === 'string' && candidate !== '' ? candidate : null
}
