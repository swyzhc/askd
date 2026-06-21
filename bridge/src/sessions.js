// Session store with JSON-file persistence (no database, per spec).
//
// One session per normalized URL key. A session holds its backend choice, the
// optional local code root (cwd), the model override, the display history, and
// the native Claude session id used for resume.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
} from 'node:fs'
import { SESSIONS_FILE, ensureDataDir } from './config.js'
import { warn } from './logger.js'

const STORE_VERSION = 1
const MAX_MESSAGES = 500 // hard cap so a runaway session can't grow unbounded
const VALID_BACKENDS = new Set(['claude', 'codex'])

/** @type {{ version: number, sessions: Record<string, any> }} */
let store = { version: STORE_VERSION, sessions: {} }
let loaded = false

function now() {
  return Date.now()
}

function load() {
  if (loaded) return
  ensureDataDir()
  if (existsSync(SESSIONS_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.sessions) {
        store = { version: STORE_VERSION, sessions: parsed.sessions }
      }
    } catch (e) {
      // Corrupt store — preserve it for forensics, start clean rather than crash.
      warn(`sessions.json unreadable (${e.message}); backing up and resetting`)
      try {
        copyFileSync(SESSIONS_FILE, SESSIONS_FILE + '.corrupt')
      } catch {
        /* ignore */
      }
      store = { version: STORE_VERSION, sessions: {} }
    }
  }
  loaded = true
}

// Atomic write: temp file + rename, so a crash mid-write can't truncate the store.
function persist() {
  ensureDataDir()
  const tmp = SESSIONS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(tmp, SESSIONS_FILE)
}

function freshSession(key, seed = {}) {
  return {
    key,
    url: seed.url || null,
    title: seed.title || null,
    backend: VALID_BACKENDS.has(seed.backend) ? seed.backend : 'claude',
    cwd: seed.cwd || null,
    model: seed.model || null,
    claudeSessionId: null, // native session id for Claude resume
    messages: [], // [{ role, content, ts }]
    pageSegments: [], // numbered page segments, kept for citation verification
    createdAt: now(),
    updatedAt: now(),
  }
}

/** Get a session by key, or undefined. */
export function getSession(key) {
  load()
  return store.sessions[key]
}

/** Get an existing session or create a new one seeded with metadata. */
export function getOrCreateSession(key, seed = {}) {
  load()
  let s = store.sessions[key]
  if (!s) {
    s = freshSession(key, seed)
    store.sessions[key] = s
    persist()
  } else if (seed.url || seed.title) {
    // Keep the freshest url/title without disturbing the conversation.
    let touched = false
    if (seed.url && s.url !== seed.url) {
      s.url = seed.url
      touched = true
    }
    if (seed.title && s.title !== seed.title) {
      s.title = seed.title
      touched = true
    }
    if (touched) {
      s.updatedAt = now()
      persist()
    }
  }
  return s
}

/**
 * Update mutable session settings. Only whitelisted fields are accepted.
 * Callers must pre-validate cwd (see safety.validateCwd).
 */
export function updateSession(key, patch = {}) {
  load()
  const s = store.sessions[key]
  if (!s) return undefined
  if ('backend' in patch && VALID_BACKENDS.has(patch.backend)) {
    s.backend = patch.backend
  }
  if ('cwd' in patch) {
    s.cwd = patch.cwd || null
  }
  if ('model' in patch) {
    s.model = patch.model || null
  }
  if ('title' in patch && patch.title) s.title = patch.title
  if ('url' in patch && patch.url) s.url = patch.url
  s.updatedAt = now()
  persist()
  return s
}

/** Append a message to a session's display history. */
export function appendMessage(key, role, content) {
  load()
  const s = store.sessions[key]
  if (!s) return undefined
  s.messages.push({ role, content, ts: now() })
  if (s.messages.length > MAX_MESSAGES) {
    s.messages = s.messages.slice(-MAX_MESSAGES)
  }
  s.updatedAt = now()
  persist()
  return s
}

/** Persist the native Claude session id used for resume. */
export function setClaudeSessionId(key, id) {
  load()
  const s = store.sessions[key]
  if (!s) return
  s.claudeSessionId = id || null
  s.updatedAt = now()
  persist()
}

/**
 * Persist the page's citation segment map. Kept so later resume turns (which
 * don't re-send the page) can still resolve and verify the answer's [n] refs.
 */
export function setPageSegments(key, segments) {
  load()
  const s = store.sessions[key]
  if (!s) return
  s.pageSegments = Array.isArray(segments) ? segments : []
  s.updatedAt = now()
  persist()
}

/**
 * Start a new conversation for a page: clear history and the native session id
 * but keep the backend / cwd / model settings.
 */
export function newConversation(key) {
  load()
  const s = store.sessions[key]
  if (!s) return undefined
  s.messages = []
  s.claudeSessionId = null
  s.pageSegments = []
  s.updatedAt = now()
  persist()
  return s
}

/** List session summaries (without full message bodies), newest first. */
export function listSessions() {
  load()
  return Object.values(store.sessions)
    .map((s) => ({
      key: s.key,
      url: s.url,
      title: s.title,
      backend: s.backend,
      cwd: s.cwd,
      model: s.model,
      messageCount: s.messages.length,
      updatedAt: s.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}
