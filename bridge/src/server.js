#!/usr/bin/env node
// askd local bridge — read-only reading assistant proxy.
//
// Binds 127.0.0.1 only. Every route except /healthz requires a bearer token.
// CORS is restricted to chrome-extension:// origins.
import { createServer } from 'node:http'
import { HOST, PORT, NAME, VERSION, loadOrCreateToken } from './config.js'
import { log, error as logError } from './logger.js'
import {
  applyCors,
  isAllowedOrigin,
  handlePreflight,
  checkAuth,
  sendJson,
  sendError,
  readJsonBody,
  startSse,
  sseSend,
  sseClose,
} from './http.js'
import { normalizeUrlKey } from './urlkey.js'
import {
  getSession,
  getOrCreateSession,
  updateSession,
  appendMessage,
  setClaudeSessionId,
  newConversation,
  listSessions,
} from './sessions.js'
import { validateCwd } from './safety.js'
import { capabilities } from './capabilities.js'
import {
  getFetcherForUrl,
  runFetcher,
  listFetchers,
  fetcherAvailability,
} from './fetchers.js'
import { runClaude } from './adapters/claude.js'
import { runCodex } from './adapters/codex.js'
import { buildClaudeTurn, buildCodexPrompt } from './prompt.js'

const TOKEN = loadOrCreateToken()

function publicSession(s) {
  return {
    key: s.key,
    url: s.url,
    title: s.title,
    backend: s.backend,
    cwd: s.cwd,
    model: s.model,
    hasLocalAccess: Boolean(s.cwd),
    hasHistory: s.messages.length > 0,
    messages: s.messages,
  }
}

function oneLine(text, max = 200) {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

function composeUserDisplay(message, quote) {
  const q = quote ? `> ${oneLine(quote)}\n\n` : ''
  const m = (message || '').trim() || (quote ? '(question about the selection)' : '')
  return q + m
}

// --- route handlers ---

async function handleInfo(req, res) {
  const [caps, avail] = await Promise.all([capabilities(), fetcherAvailability()])
  const availByName = Object.fromEntries(avail.map((a) => [a.name, a.available]))
  const fetchers = listFetchers().map((f) => ({
    ...f,
    available: availByName[f.name] || false,
  }))
  sendJson(res, 200, { name: NAME, version: VERSION, host: HOST, backends: caps, fetchers })
}

function handleGetSession(req, res, url) {
  const raw = url.searchParams.get('url')
  if (!raw) return sendError(res, 400, 'bad_request', 'url query param is required')
  const key = normalizeUrlKey(raw)
  const s = getOrCreateSession(key, { url: raw, title: url.searchParams.get('title') })
  sendJson(res, 200, { session: publicSession(s) })
}

async function handlePostSession(req, res) {
  const body = await readJsonBody(req)
  if (!body.url) return sendError(res, 400, 'bad_request', 'url is required')
  const key = normalizeUrlKey(body.url)
  const s = getOrCreateSession(key, { url: body.url, title: body.title })

  const patch = {}
  let resetContext = false
  if ('backend' in body) {
    if (body.backend !== 'claude' && body.backend !== 'codex') {
      return sendError(res, 400, 'bad_request', 'backend must be "claude" or "codex"')
    }
    if (body.backend !== s.backend) resetContext = true
    patch.backend = body.backend
  }
  if ('model' in body) patch.model = body.model || null
  if ('cwd' in body) {
    const v = validateCwd(body.cwd)
    if (!v.ok) return sendError(res, 400, 'invalid_cwd', v.error)
    if ((s.cwd || null) !== (v.cwd || null)) resetContext = true
    patch.cwd = v.cwd
  }
  updateSession(key, patch)
  // Changing backend or cwd changes the model's access/identity — start a fresh
  // native conversation (history stays visible) so resume can't cross contexts.
  if (resetContext) setClaudeSessionId(key, null)
  sendJson(res, 200, { session: publicSession(getSession(key)) })
}

async function handleNewConversation(req, res) {
  const body = await readJsonBody(req)
  if (!body.url) return sendError(res, 400, 'bad_request', 'url is required')
  const key = normalizeUrlKey(body.url)
  getOrCreateSession(key, { url: body.url, title: body.title })
  const s = newConversation(key)
  sendJson(res, 200, { session: publicSession(s) })
}

function handleListSessions(req, res) {
  sendJson(res, 200, { sessions: listSessions() })
}

async function handleFetch(req, res) {
  const body = await readJsonBody(req)
  if (!body.url) return sendError(res, 400, 'bad_request', 'url is required')
  const fetcher = getFetcherForUrl(body.url)
  if (!fetcher) {
    return sendJson(res, 200, {
      ok: false,
      code: 'no_fetcher',
      message: 'No document fetcher is configured for this site.',
    })
  }
  const result = await runFetcher(fetcher, body.url)
  sendJson(res, 200, result)
}

async function handleChat(req, res) {
  let body
  try {
    body = await readJsonBody(req)
  } catch (e) {
    return sendError(res, 400, 'bad_request', e.message)
  }
  const { url, message, quote, pageTitle, pageContext, contextSource } = body
  if (!url) return sendError(res, 400, 'bad_request', 'url is required')
  if ((!message || !message.trim()) && !quote) {
    return sendError(res, 400, 'bad_request', 'message or quote is required')
  }

  const key = normalizeUrlKey(url)
  const session = getOrCreateSession(key, { url, title: pageTitle })
  const backend = session.backend || 'claude'

  const abortController = new AbortController()
  const abort = () => abortController.abort()
  req.on('close', abort)
  res.on('close', abort)

  startSse(req, res)
  sseSend(res, 'meta', {
    backend,
    cwd: session.cwd,
    model: session.model,
    hasLocalAccess: Boolean(session.cwd),
  })

  // Record the user's turn for display + Codex history splicing.
  appendMessage(key, 'user', composeUserDisplay(message, quote))

  let gen
  if (backend === 'codex') {
    const prompt = buildCodexPrompt({
      session,
      message,
      quote,
      title: pageTitle,
      url,
      context: pageContext,
      contextSource,
    })
    gen = runCodex({ session, prompt, abortController })
  } else {
    // Claude keeps history via resume; only send page context on the first turn.
    const includeContext = !session.claudeSessionId
    const prompt = buildClaudeTurn({
      message,
      quote,
      title: pageTitle,
      url,
      context: pageContext,
      contextSource,
      includeContext,
    })
    gen = runClaude({ session, prompt, abortController })
  }

  let assistantText = ''
  try {
    for await (const ev of gen) {
      if (ev.type === 'token') {
        assistantText += ev.text
        sseSend(res, 'token', { text: ev.text })
      } else if (ev.type === 'tool') {
        sseSend(res, 'tool', { name: ev.name })
      } else if (ev.type === 'done') {
        if (ev.sessionId) setClaudeSessionId(key, ev.sessionId)
        const finalText = ev.text || assistantText
        appendMessage(key, 'assistant', finalText)
        sseSend(res, 'done', {
          text: finalText,
          isError: Boolean(ev.isError),
          sessionId: ev.sessionId || null,
        })
      } else if (ev.type === 'aborted') {
        sseSend(res, 'aborted', {})
      } else if (ev.type === 'error') {
        sseSend(res, 'error', { message: ev.message })
      }
    }
  } catch (e) {
    sseSend(res, 'error', { message: String(e?.message || e) })
  } finally {
    req.off?.('close', abort)
    res.off?.('close', abort)
    sseClose(res)
  }
}

// --- router ---

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    const path = url.pathname

    if (req.method === 'OPTIONS') return handlePreflight(req, res)

    // Unauthenticated health check.
    if (req.method === 'GET' && path === '/healthz') {
      applyCors(req, res)
      return sendJson(res, 200, { ok: true, name: NAME, version: VERSION })
    }

    // Reject non-extension browser origins outright.
    if (!isAllowedOrigin(req)) {
      return sendError(res, 403, 'forbidden_origin', 'origin not allowed')
    }
    applyCors(req, res)

    // Everything below requires a valid bearer token.
    if (!checkAuth(req, TOKEN)) {
      return sendError(res, 401, 'unauthorized', 'missing or invalid bearer token')
    }

    if (req.method === 'GET' && path === '/api/info') return handleInfo(req, res)
    if (req.method === 'GET' && path === '/api/session') return handleGetSession(req, res, url)
    if (req.method === 'POST' && path === '/api/session') return handlePostSession(req, res)
    if (req.method === 'POST' && path === '/api/session/new') return handleNewConversation(req, res)
    if (req.method === 'GET' && path === '/api/sessions') return handleListSessions(req, res)
    if (req.method === 'POST' && path === '/api/fetch') return handleFetch(req, res)
    if (req.method === 'POST' && path === '/api/chat') return handleChat(req, res)

    return sendError(res, 404, 'not_found', `no route for ${req.method} ${path}`)
  } catch (e) {
    logError('request failed:', e)
    if (!res.headersSent) sendError(res, 500, 'internal_error', String(e?.message || e))
    else sseClose(res)
  }
})

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`
  const line = '='.repeat(60)
  log(`${NAME} ${VERSION} listening`)
  console.log(`
${line}
  askd bridge is running

  URL:    ${base}
  Token:  ${TOKEN}
  Health: ${base}/healthz

  Paste the URL and Token into the askd side panel → Settings.
  Bound to ${HOST} only. Keep the token private.
${line}
`)
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    logError(`port ${PORT} is already in use. Set ASKD_PORT to choose another.`)
    process.exit(1)
  }
  logError('server error:', e)
  process.exit(1)
})
