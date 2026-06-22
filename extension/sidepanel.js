'use strict'

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: false })
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})
function renderMarkdown(raw) {
  return DOMPurify.sanitize(marked.parse(raw || ''), { USE_PROFILES: { html: true } })
}

// ---------- element refs ----------
const $ = (id) => document.getElementById(id)
const els = {
  newConvBtn: $('newConvBtn'),
  sessionsBtn: $('sessionsBtn'),
  settingsBtn: $('settingsBtn'),
  pageTitle: $('pageTitle'),
  backendSelect: $('backendSelect'),
  cwdBadge: $('cwdBadge'),
  banner: $('banner'),
  messages: $('messages'),
  composer: $('composer'),
  quoteList: $('quoteList'),
  input: $('input'),
  sendBtn: $('sendBtn'),
  stopBtn: $('stopBtn'),
  settingsDrawer: $('settingsDrawer'),
  bridgeUrl: $('bridgeUrl'),
  token: $('token'),
  testBtn: $('testBtn'),
  saveSettingsBtn: $('saveSettingsBtn'),
  settingsStatus: $('settingsStatus'),
  cwdInput: $('cwdInput'),
  modelInput: $('modelInput'),
  saveSessionBtn: $('saveSessionBtn'),
  sessionStatus: $('sessionStatus'),
  closeSettings: $('closeSettings'),
  sessionsDrawer: $('sessionsDrawer'),
  sessionsList: $('sessionsList'),
  closeSessions: $('closeSessions'),
}

// ---------- state ----------
const state = {
  cfg: { bridgeUrl: 'http://127.0.0.1:8765', token: '' },
  tabId: null,
  page: null,
  session: null,
  contextSource: 'dom',
  fetchCache: {},
  fetcherMatchers: [],
  quotes: [],
  lastSentContextByUrl: {},
  streaming: false,
  port: null,
  assistantEl: null,
  assistantWrap: null,
  traceEl: null,
  assistantRaw: '',
  renderQueued: false,
  citations: null, // { used: [{n, valid, text}], invalidNumbers: [] } for the current answer
  finalized: false, // whether the current stream already reached a terminal state
}

// ---------- bridge proxy (via background) ----------
function api(action, args) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ kind: 'api', action, args }, (resp) => {
      if (chrome.runtime.lastError)
        return reject(new Error(chrome.runtime.lastError.message))
      if (!resp) return reject(new Error('No response from the background worker.'))
      if (resp.ok) return resolve(resp.data)
      const e = new Error(resp.message)
      e.code = resp.error
      reject(e)
    })
  })
}

// ---------- small utils ----------
function oneLine(text, max = 200) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}
function shortPath(p) {
  const parts = String(p).split('/').filter(Boolean)
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  )
}
function setStatus(el, msg, kind) {
  el.textContent = msg
  el.className = 'status' + (kind ? ' ' + kind : '')
}
function showBanner(msg, kind = 'warn') {
  els.banner.textContent = msg
  els.banner.className = 'banner' + (kind === 'error' ? ' error' : '')
}
function clearBanner() {
  els.banner.className = 'banner hidden'
  els.banner.textContent = ''
}
function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight
}
function friendlyError(data) {
  const code = data && data.code
  if (code === 'bridge_unreachable')
    return 'Bridge not reachable. Start it with `npm start` in bridge/, then check Settings.'
  if (code === 'unauthorized')
    return 'Bridge rejected the token (401). Open Settings and fix the token.'
  return (data && data.message) || 'Something went wrong.'
}

// ---------- init ----------
async function init() {
  wireEvents()
  await loadConfig()
  if (!state.cfg.token) {
    openSettings()
    setStatus(
      els.settingsStatus,
      'Start the bridge (npm start in bridge/), then paste its URL and token here.',
      '',
    )
  }
  await refreshConnection()
  await loadActiveTab()
  await checkPendingCapture()
}

async function loadConfig() {
  const { bridgeUrl, token } = await chrome.storage.local.get(['bridgeUrl', 'token'])
  state.cfg.bridgeUrl = bridgeUrl || 'http://127.0.0.1:8765'
  state.cfg.token = token || ''
  els.bridgeUrl.value = state.cfg.bridgeUrl
  els.token.value = state.cfg.token
}

async function refreshConnection() {
  try {
    const info = await api('info')
    // Learn which sites have a server-side document fetcher configured.
    state.fetcherMatchers = (info.fetchers || []).map((f) => ({
      name: f.name,
      res: (f.hosts || []).map(safeRegex).filter(Boolean),
    }))
    clearBanner()
    return true
  } catch (e) {
    showBanner(friendlyError({ code: e.code, message: e.message }), 'error')
    return false
  }
}

function safeRegex(src) {
  try {
    return new RegExp(src, 'i')
  } catch {
    return null
  }
}
function matchFetcher(url) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  for (const f of state.fetcherMatchers) {
    if (f.res.some((re) => re.test(host))) return f
  }
  return null
}

// ---------- page extraction ----------
function extractTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { cmd: 'extract' }, (resp) => {
        if (chrome.runtime.lastError) return resolve(null)
        resolve(resp)
      })
    } catch {
      resolve(null)
    }
  })
}

function getTabSelectionViaMessage(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { cmd: 'getSelection' }, (resp) => {
        if (chrome.runtime.lastError) return resolve('')
        resolve((resp && resp.selection) || '')
      })
    } catch {
      resolve('')
    }
  })
}
async function getTabSelection(tabId) {
  const viaMsg = await getTabSelectionViaMessage(tabId)
  if (viaMsg) return viaMsg
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => String(window.getSelection ? window.getSelection() : '').trim(),
    })
    return (res && res.result) || ''
  } catch {
    return ''
  }
}

// Fallback extraction (no Readability) for tabs where the content script isn't
// present. Requires activeTab/host access, which holds right after the user
// opens the panel via the toolbar or the keyboard command.
async function extractViaScripting(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sel = String(window.getSelection ? window.getSelection() : '').trim()
        const text = (document.body ? document.body.innerText : '').trim()
        const isPdf =
          document.contentType === 'application/pdf' || /\.pdf($|\?)/i.test(location.href)
        return {
          ok: true,
          url: location.href,
          title: document.title || '',
          kind: isPdf ? 'pdf' : 'web',
          text: text.slice(0, 400000),
          selection: sel,
          byReadability: false,
        }
      },
    })
    return res && res.result ? res.result : null
  } catch {
    return null
  }
}


async function loadActiveTab() {
  let tab
  try {
    ;[tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  } catch {
    /* ignore */
  }
  if (!tab || tab.id == null) {
    els.pageTitle.textContent = 'No active tab'
    return
  }
  state.tabId = tab.id
  // Prefer the content script (it has Readability). Fall back to an on-demand
  // injection for tabs opened before askd was installed.
  let page = await extractTab(tab.id)
  if (!page || !page.ok) page = await extractViaScripting(tab.id)
  state.page = page && page.ok
    ? page
    : { ok: false, url: tab.url || '', title: tab.title || '', kind: 'web', text: '', selection: '' }

  els.pageTitle.textContent = state.page.title || state.page.url || '—'
  els.pageTitle.title = state.page.url || ''

  await prepareContext()
  await loadSession()
}

async function prepareContext() {
  const page = state.page
  if (!page) return
  state.contextSource = page.byReadability ? 'readability' : 'dom'

  const fetcher = matchFetcher(page.url)
  if (fetcher) {
    await prepareFetched(fetcher)
    return
  }
  if (!page.text) {
    const isHttp = /^https?:/i.test(page.url || '')
    if (page.kind === 'pdf')
      showBanner(
        "This looks like a PDF. askd can't reliably extract PDF text, so answers may be limited.",
      )
    else if (!page.ok && isHttp)
      showBanner(
        "askd couldn't read this page yet — reload it once. (Content scripts don't attach to tabs that were open before the extension was installed.)",
      )
    else
      showBanner(
        "Couldn't read this page's text (it may be a browser or internal page). You can still ask, but there's no page context.",
      )
  } else {
    clearBanner()
  }
}

async function prepareFetched(fetcher) {
  const url = state.page.url
  const ck = fetcher.name + '|' + url
  if (state.fetchCache[ck]) return applyFetched(fetcher, state.fetchCache[ck])
  showBanner(`Fetching this document via ${fetcher.name}…`)
  try {
    const r = await api('fetchDoc', { url })
    state.fetchCache[ck] = r
    applyFetched(fetcher, r)
  } catch (e) {
    const r = { ok: false, code: e.code, message: e.message }
    state.fetchCache[ck] = r
    applyFetched(fetcher, r)
  }
}

function fetcherErrorText(r) {
  switch (r && r.code) {
    case 'fetcher_missing':
      return 'the fetch command is not installed'
    case 'no_fetcher':
      return 'no fetcher configured for this site'
    case 'scope_missing':
      return 'missing permission/scope for this doc'
    case 'auth_required':
      return 'the fetch tool is not logged in'
    case 'doc_not_found':
      return 'document not found'
    case 'timeout':
      return 'the fetch timed out'
    default:
      return (r && r.message) || 'unknown error'
  }
}

function applyFetched(fetcher, r) {
  if (r && r.ok && r.markdown) {
    state.page.fetchedMarkdown = r.markdown
    state.contextSource = fetcher.name
    clearBanner()
  } else {
    state.page.fetchedMarkdown = null
    state.contextSource = 'dom-fallback'
    showBanner(
      `${fetcher.name} fetch failed (${fetcherErrorText(r)}). Falling back to the page's visible text — results may be less accurate.`,
    )
  }
}

function contextForSend() {
  const page = state.page
  if (!page) return ''
  if (page.fetchedMarkdown) return page.fetchedMarkdown
  return page.text || ''
}

// Re-extract the live DOM right before sending, so edits made after the panel
// bound to the tab are seen. Fetcher pages keep their cached markdown (re-running
// the fetch CLI on every message would be too slow).
async function refreshPageSnapshot() {
  if (!state.page || state.tabId == null) return
  if (state.page.fetchedMarkdown) return
  let fresh = await extractTab(state.tabId)
  if (!fresh || !fresh.ok) fresh = await extractViaScripting(state.tabId)
  if (fresh && fresh.ok && fresh.text) {
    state.page.text = fresh.text
    state.page.byReadability = fresh.byReadability
  }
}

// ---------- session ----------
async function loadSession() {
  if (!state.page) return
  try {
    const { session } = await api('getSession', {
      url: state.page.url,
      title: state.page.title,
    })
    state.session = session
    applySessionToUI(session)
    renderHistory(session.messages)
  } catch {
    /* connection errors already surfaced */
  }
}

function applySessionToUI(s) {
  els.backendSelect.value = s.backend || 'claude'
  els.cwdInput.value = s.cwd || ''
  els.modelInput.value = s.model || ''
  if (s.cwd) {
    els.cwdBadge.textContent = shortPath(s.cwd)
    els.cwdBadge.className = 'badge badge-ok'
    els.cwdBadge.title = s.cwd
  } else {
    els.cwdBadge.textContent = 'no local access'
    els.cwdBadge.className = 'badge badge-muted'
    els.cwdBadge.title = 'Set a local code directory'
  }
}

// ---------- message rendering ----------
function emptyStateEl() {
  const d = document.createElement('div')
  d.className = 'empty'
  d.textContent =
    'Ask anything about the current page. askd reads it and answers using your local Claude Code or Codex — read-only.'
  return d
}
function removeEmptyState() {
  els.messages.querySelectorAll('.empty').forEach((n) => n.remove())
}
function renderHistory(messages) {
  els.messages.innerHTML = ''
  if (!messages || messages.length === 0) {
    els.messages.appendChild(emptyStateEl())
    return
  }
  for (const m of messages) addMessageBubble(m.role, m.content)
  scrollToBottom()
}
function addMessageBubble(role, content, opts = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'msg ' + role + (opts.error ? ' error-msg' : '')
  const r = document.createElement('div')
  r.className = 'role'
  r.textContent = role === 'user' ? 'You' : 'askd'
  wrap.appendChild(r)
  const body = document.createElement('div')
  body.className = 'md'
  body.innerHTML = renderMarkdown(content)
  wrap.appendChild(body)
  els.messages.appendChild(wrap)
  scrollToBottom()
  return { wrap, body }
}

// ---------- send / stream ----------
function setStreaming(on) {
  state.streaming = on
  els.sendBtn.classList.toggle('hidden', on)
  els.stopBtn.classList.toggle('hidden', !on)
}
function queueRender() {
  if (state.renderQueued) return
  state.renderQueued = true
  requestAnimationFrame(() => {
    state.renderQueued = false
    if (state.assistantEl) {
      state.assistantEl.innerHTML = renderMarkdown(state.assistantRaw)
      scrollToBottom()
    }
  })
}

async function send() {
  const text = els.input.value.trim()
  if ((!text && state.quotes.length === 0) || state.streaming) return
  if (!state.page) {
    showBanner('No active page to ask about.', 'error')
    return
  }
  removeEmptyState()

  const quoteHead = state.quotes.map((q) => `> ${oneLine(q)}`).join('\n')
  const userContent = (quoteHead ? quoteHead + '\n\n' : '') + text
  addMessageBubble('user', userContent)

  const a = addMessageBubble('assistant', '')
  state.assistantWrap = a.wrap
  state.assistantEl = a.body
  state.assistantRaw = ''
  state.citations = null
  state.finalized = false
  a.body.classList.add('cursor-blink')
  const trace = document.createElement('div')
  trace.className = 'tool-trace hidden'
  a.wrap.insertBefore(trace, a.body)
  state.traceEl = trace

  // Refresh the DOM snapshot so post-binding edits are seen, then flag whether
  // the page changed since we last sent it (Claude re-embeds context on change).
  await refreshPageSnapshot()
  const pageContext = contextForSend()
  const contextChanged = state.lastSentContextByUrl[state.page.url] !== pageContext
  state.lastSentContextByUrl[state.page.url] = pageContext

  const payload = {
    url: state.page.url,
    message: text,
    quotes: state.quotes.slice(),
    pageTitle: state.page.title,
    pageContext,
    contextSource: state.contextSource,
    contextChanged,
  }

  els.input.value = ''
  els.input.style.height = 'auto'
  clearQuotes()
  setStreaming(true)

  const port = chrome.runtime.connect({ name: 'askd-chat' })
  state.port = port
  port.onMessage.addListener((m) => onChatEvent(m.event, m.data))
  port.onDisconnect.addListener(() => {
    if (state.streaming) finalizeStream({ aborted: true })
  })
  port.postMessage({ type: 'start', payload })
}

function onChatEvent(event, data) {
  switch (event) {
    case 'meta':
      if (data && data.backend) els.backendSelect.value = data.backend
      break
    case 'tool':
      if (state.traceEl) {
        state.traceEl.classList.remove('hidden')
        state.traceEl.textContent = `· using ${data.name}…`
      }
      break
    case 'token':
      state.assistantRaw += data.text || ''
      queueRender()
      break
    case 'citations':
      state.citations = data || null
      break
    case 'done':
      if (data && typeof data.text === 'string' && data.text) state.assistantRaw = data.text
      finalizeStream({ isError: !!(data && data.isError) })
      break
    case 'aborted':
      finalizeStream({ aborted: true })
      break
    case 'error':
      streamError(data)
      break
  }
}

function finalizeStream({ isError = false, aborted = false } = {}) {
  // Guard against double-finalize: a terminal event (done/error) and the
  // subsequent port disconnect can both land here; only the first wins, so a
  // clean completion is never overwritten with a spurious "(stopped)".
  if (state.finalized) return
  state.finalized = true
  if (state.assistantEl) {
    state.assistantEl.classList.remove('cursor-blink')
    let raw = state.assistantRaw
    if (aborted) raw += (raw ? '\n\n' : '') + '_(stopped)_'
    state.assistantEl.innerHTML = renderMarkdown(raw || '_(no output)_')
    // Decoration must never break finalize — a throw here used to leave
    // state.streaming stuck true, so the next port disconnect appended "(stopped)".
    if (!isError && !aborted && state.citations) {
      try {
        decorateCitations(state.assistantEl, state.citations)
      } catch {
        /* leave the plain [n] text in place */
      }
    }
    if (isError && state.assistantWrap) state.assistantWrap.classList.add('error-msg')
  }
  teardownStream()
  scrollToBottom()
}

// Turn the answer's [n] references into clickable footnotes. Walks text nodes
// (skipping code/links) so we never corrupt the rendered markup, and resolves
// each number against the verified citation map from the bridge. Clicking a
// verified citation asks the content script to scroll to and highlight the
// source passage on the page.
function decorateCitations(root, citations) {
  const byNum = new Map((citations.used || []).map((u) => [u.n, u]))
  if (byNum.size === 0) return
  const skip = new Set(['CODE', 'PRE', 'A'])
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentElement
      while (p && p !== root) {
        if (skip.has(p.tagName)) return NodeFilter.FILTER_REJECT
        p = p.parentElement
      }
      return /\[\d+\]/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  const targets = []
  while (walker.nextNode()) targets.push(walker.currentNode)

  for (const node of targets) {
    const frag = document.createDocumentFragment()
    let last = 0
    const re = /\[(\d+)\]/g
    let m
    while ((m = re.exec(node.nodeValue)) !== null) {
      const n = Number(m[1])
      const cite = byNum.get(n)
      if (!cite) continue // a bracketed number we didn't track — leave as text
      if (m.index > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, m.index)))
      frag.appendChild(makeCiteEl(n, cite))
      last = m.index + m[0].length
    }
    if (last === 0) continue
    if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)))
    node.parentNode.replaceChild(frag, node)
  }
}

function makeCiteEl(n, cite) {
  const sup = document.createElement('sup')
  sup.className = 'cite' + (cite.valid ? '' : ' cite-invalid')
  sup.textContent = `[${n}]`
  if (cite.valid) {
    sup.title = oneLine(cite.text, 160)
    sup.addEventListener('click', () => highlightOnPage(cite.text))
  } else {
    sup.title = 'This citation was not found in the page.'
  }
  return sup
}

// Ask the content script to scroll to and (transiently) select the cited text.
// Uses the browser's native find — no DOM mutation, honouring askd's read-only
// promise on the page.
function highlightOnPage(text) {
  if (state.tabId == null || !text) return
  try {
    chrome.tabs.sendMessage(state.tabId, { cmd: 'highlight', text }, () => void chrome.runtime.lastError)
  } catch {
    /* tab gone */
  }
}

function streamError(data) {
  state.finalized = true
  const msg = friendlyError(data)
  if (state.assistantEl) {
    state.assistantEl.classList.remove('cursor-blink')
    const prefix = state.assistantRaw ? state.assistantRaw + '\n\n---\n' : ''
    state.assistantEl.innerHTML = renderMarkdown(prefix + '**Error:** ' + msg)
    if (state.assistantWrap) state.assistantWrap.classList.add('error-msg')
  }
  showBanner(msg, 'error')
  teardownStream()
}

function teardownStream() {
  setStreaming(false)
  if (state.traceEl) state.traceEl.classList.add('hidden')
  try {
    if (state.port) state.port.disconnect()
  } catch {
    /* ignore */
  }
  state.port = null
  state.assistantEl = null
  state.assistantWrap = null
  state.traceEl = null
  state.assistantRaw = ''
}

function stop() {
  if (!state.streaming) return
  try {
    state.port && state.port.postMessage({ type: 'stop' })
  } catch {
    /* ignore */
  }
}

// ---------- quotes (multiple selections) ----------
const MAX_QUOTES = 10
function addQuote(text) {
  const t = String(text || '').trim()
  if (!t || state.quotes.includes(t) || state.quotes.length >= MAX_QUOTES) return
  state.quotes.push(t)
  renderQuotes()
}
function removeQuote(i) {
  state.quotes.splice(i, 1)
  renderQuotes()
}
function clearQuotes() {
  state.quotes = []
  renderQuotes()
}
function renderQuotes() {
  els.quoteList.innerHTML = ''
  if (state.quotes.length === 0) {
    els.quoteList.classList.add('hidden')
    return
  }
  els.quoteList.classList.remove('hidden')
  state.quotes.forEach((q, i) => {
    const chip = document.createElement('div')
    chip.className = 'quote-chip'
    const span = document.createElement('span')
    span.textContent = oneLine(q, 240)
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.title = 'Remove quote'
    btn.textContent = '×'
    btn.addEventListener('click', () => removeQuote(i))
    chip.appendChild(span)
    chip.appendChild(btn)
    els.quoteList.appendChild(chip)
  })
}
async function captureSelection(tabId) {
  const id = tabId != null ? tabId : state.tabId
  if (id == null) return
  const sel = await getTabSelection(id)
  if (sel) addQuote(sel)
  focusInput()
}

// Best-effort: pull keyboard focus into the panel so the next keystroke (Enter /
// ⌘+Enter to send) goes to the chat, not the page. When the page still owns
// focus (the user just selected text there), a side panel can't always steal it
// programmatically — so we first focus our own window, then the input, and retry
// once on the next frame after the quote chip has rendered.
function focusInput() {
  const grab = () => {
    try {
      window.focus()
      els.input.focus({ preventScroll: true })
    } catch {
      /* ignore */
    }
  }
  grab()
  requestAnimationFrame(grab)
}
async function checkPendingCapture() {
  try {
    const { pendingCapture } = await chrome.storage.session.get('pendingCapture')
    if (pendingCapture && Date.now() - pendingCapture.at < 5000) {
      await captureSelection(pendingCapture.tabId)
      await chrome.storage.session.remove('pendingCapture')
    }
  } catch {
    /* ignore */
  }
}

// ---------- settings ----------
function openSettings() {
  els.settingsDrawer.classList.remove('hidden')
}
function closeSettings() {
  els.settingsDrawer.classList.add('hidden')
}
async function persistSettingsFromInputs() {
  const bridgeUrl = els.bridgeUrl.value.trim() || 'http://127.0.0.1:8765'
  const token = els.token.value.trim()
  await chrome.storage.local.set({ bridgeUrl, token })
  state.cfg = { bridgeUrl, token }
}

async function testConnection() {
  setStatus(els.settingsStatus, 'Testing…', '')
  await persistSettingsFromInputs()
  try {
    const info = await api('testConnection')
    const b = info.backends
    const fetchers = (info.fetchers || [])
      .map((f) => `${f.name}: ${f.available ? 'ok' : 'missing'}`)
      .join(' · ')
    const parts = [
      `Claude: ${b.claude.available ? 'found' : 'missing'}`,
      `Codex: ${b.codex.available ? 'found' : 'missing'}`,
    ]
    if (fetchers) parts.push(fetchers)
    setStatus(
      els.settingsStatus,
      `Connected. ${parts.join(' · ')}. ("found" = CLI installed; make sure Claude Code is also logged in.)`,
      'ok',
    )
    clearBanner()
  } catch (e) {
    setStatus(els.settingsStatus, friendlyError({ code: e.code, message: e.message }), 'bad')
  }
}

async function saveSettings() {
  await persistSettingsFromInputs()
  setStatus(els.settingsStatus, 'Saved.', 'ok')
  if (await refreshConnection()) await loadSession()
}

async function applySessionSettings() {
  if (!state.page) return
  setStatus(els.sessionStatus, 'Applying…', '')
  try {
    const { session } = await api('setSession', {
      url: state.page.url,
      patch: {
        backend: els.backendSelect.value,
        cwd: els.cwdInput.value.trim(),
        model: els.modelInput.value.trim(),
      },
    })
    state.session = session
    applySessionToUI(session)
    setStatus(els.sessionStatus, 'Applied to this page.', 'ok')
  } catch (e) {
    setStatus(els.sessionStatus, e.message, 'bad')
  }
}

async function quickSetBackend() {
  if (!state.page) return
  try {
    const { session } = await api('setSession', {
      url: state.page.url,
      patch: { backend: els.backendSelect.value },
    })
    state.session = session
    applySessionToUI(session)
  } catch (e) {
    showBanner(e.message, 'error')
  }
}

async function newConversation() {
  if (!state.page) return
  try {
    const { session } = await api('newConversation', { url: state.page.url })
    state.session = session
    renderHistory(session.messages)
    clearBanner()
  } catch (e) {
    showBanner(e.message, 'error')
  }
}

// ---------- sessions drawer ----------
async function openSessions() {
  els.sessionsDrawer.classList.remove('hidden')
  els.sessionsList.innerHTML = '<div class="hint">Loading…</div>'
  try {
    const { sessions } = await api('listSessions')
    renderSessionsList(sessions)
  } catch (e) {
    els.sessionsList.innerHTML = `<div class="status bad">${escapeHtml(e.message)}</div>`
  }
}
function renderSessionsList(sessions) {
  els.sessionsList.innerHTML = ''
  if (!sessions || !sessions.length) {
    els.sessionsList.innerHTML = '<div class="hint">No sessions yet.</div>'
    return
  }
  for (const s of sessions) {
    const btn = document.createElement('button')
    btn.className = 'session-item'
    const t = document.createElement('div')
    t.className = 'si-title'
    t.textContent = s.title || s.url || s.key
    const meta = document.createElement('div')
    meta.className = 'si-meta'
    meta.textContent =
      `${s.backend}` +
      (s.cwd ? ' · local' : '') +
      ` · ${s.messageCount} msg` +
      (s.url ? ' · ' + s.url : '')
    btn.appendChild(t)
    btn.appendChild(meta)
    btn.title = 'Open this page in a new tab'
    btn.addEventListener('click', () => {
      if (s.url) chrome.tabs.create({ url: s.url })
    })
    els.sessionsList.appendChild(btn)
  }
}

// ---------- events ----------
function wireEvents() {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault()
    send()
  })
  els.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    // Ignore Enter while an IME is composing — confirming a candidate word
    // (e.g. Pinyin/Japanese) must not fire the message off. `isComposing` is the
    // modern signal; keyCode 229 is the legacy sentinel for the same state.
    if (e.isComposing || e.keyCode === 229) return
    if (e.shiftKey) return // Shift+Enter = newline
    e.preventDefault()
    send()
  })
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto'
    els.input.style.height = Math.min(els.input.scrollHeight, 140) + 'px'
  })
  els.stopBtn.addEventListener('click', stop)
  els.newConvBtn.addEventListener('click', newConversation)
  els.backendSelect.addEventListener('change', quickSetBackend)

  els.settingsBtn.addEventListener('click', openSettings)
  els.closeSettings.addEventListener('click', closeSettings)
  els.cwdBadge.addEventListener('click', () => {
    openSettings()
    els.cwdInput.focus()
  })
  els.testBtn.addEventListener('click', testConnection)
  els.saveSettingsBtn.addEventListener('click', saveSettings)
  els.saveSessionBtn.addEventListener('click', applySessionSettings)

  els.sessionsBtn.addEventListener('click', openSessions)
  els.closeSessions.addEventListener('click', () =>
    els.sessionsDrawer.classList.add('hidden'),
  )

  // live selection capture (Cmd+Shift+L while panel is open)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.kind === 'event' && msg.event === 'capture-selection') {
      captureSelection(msg.tabId)
    }
  })

  // follow the active tab
  chrome.tabs.onActivated.addListener(() => {
    if (!state.streaming) loadActiveTab()
  })
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!state.streaming && tabId === state.tabId && info.status === 'complete') {
      loadActiveTab()
    }
  })
}

init()
