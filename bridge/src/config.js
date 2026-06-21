// Central configuration for the askd bridge.
//
// Hard security invariants enforced here:
//   - HOST is always 127.0.0.1 (loopback). The server must never bind 0.0.0.0.
//   - A bearer token is required for every route except /healthz.
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Loopback only. Intentionally not configurable — binding a non-loopback
// address would expose local CLIs (and their file access) to the network.
export const HOST = '127.0.0.1'
export const PORT = Number(process.env.ASKD_PORT || 8765)

export const NAME = 'askd-bridge'
export const VERSION = '0.1.0'

export const DATA_DIR = process.env.ASKD_DATA_DIR || join(homedir(), '.askd')
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json')
export const TOKEN_FILE = join(DATA_DIR, 'token')

// An always-empty directory. Used as the Claude subprocess cwd for sessions
// that have no local access configured, so the SDK can never fall back to the
// bridge's own process.cwd() (which would expose the bridge source tree).
export const NO_ACCESS_DIR = join(DATA_DIR, 'no-access')

export function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  if (!existsSync(NO_ACCESS_DIR))
    mkdirSync(NO_ACCESS_DIR, { recursive: true, mode: 0o700 })
}

// Resolve the bearer token. Precedence: env override > persisted file > new.
// The generated token is written 0600 so other local users cannot read it.
export function loadOrCreateToken() {
  // Always ensure the data dir + empty no-access dir exist, regardless of how
  // the token is sourced (the no-access dir is used as Claude's cwd when a
  // session has no local access).
  ensureDataDir()
  if (process.env.ASKD_TOKEN && process.env.ASKD_TOKEN.trim()) {
    return process.env.ASKD_TOKEN.trim()
  }
  if (existsSync(TOKEN_FILE)) {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (existing) return existing
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  try {
    chmodSync(TOKEN_FILE, 0o600)
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return token
}
