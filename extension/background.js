// askd background service worker.
//
// It is the single place that talks to the local bridge: it holds the bridge
// URL + token and proxies every request, including SSE chat streaming. The side
// panel never fetches the bridge directly — it messages this worker.

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765'

async function getConfig() {
  const { bridgeUrl, token } = await chrome.storage.local.get(['bridgeUrl', 'token'])
  return { bridgeUrl: bridgeUrl || DEFAULT_BRIDGE_URL, token: token || '' }
}

const trimBase = (url) => String(url || '').replace(/\/+$/, '')

// --- non-streaming bridge calls ---

async function bridgeFetch(path, { method = 'GET', body } = {}) {
  const { bridgeUrl, token } = await getConfig()
  const base = trimBase(bridgeUrl)
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw tagged(
      'bridge_unreachable',
      `Can't reach the bridge at ${base}. Start it with "npm start" in bridge/.`,
    )
  }
  if (res.status === 401) {
    throw tagged('unauthorized', 'Bridge rejected the token (401). Check Settings → Token.')
  }
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) {
    throw tagged(
      (data && data.error) || 'bridge_error',
      (data && data.message) || `Bridge error ${res.status}`,
    )
  }
  return data
}

function tagged(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

const API = {
  info: () => bridgeFetch('/api/info'),
  testConnection: () => bridgeFetch('/api/info'),
  getSession: ({ url, title }) =>
    bridgeFetch(
      `/api/session?url=${encodeURIComponent(url)}` +
        (title ? `&title=${encodeURIComponent(title)}` : ''),
    ),
  setSession: ({ url, patch }) =>
    bridgeFetch('/api/session', { method: 'POST', body: { url, ...patch } }),
  newConversation: ({ url }) =>
    bridgeFetch('/api/session/new', { method: 'POST', body: { url } }),
  listSessions: () => bridgeFetch('/api/sessions'),
  fetchDoc: ({ url }) =>
    bridgeFetch('/api/fetch', { method: 'POST', body: { url } }),
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.kind !== 'api') return
  const fn = API[msg.action]
  if (!fn) {
    sendResponse({ ok: false, error: 'unknown_action', message: `unknown action ${msg.action}` })
    return
  }
  Promise.resolve(fn(msg.args || {}))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.code || 'error', message: err.message }))
  return true // async response
})

// --- streaming chat over a long-lived port ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'askd-chat') return
  let abort = null
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === 'start') {
      abort = new AbortController()
      try {
        await streamChat(msg.payload, abort.signal, (event, data) => {
          try {
            port.postMessage({ event, data })
          } catch {
            /* port closed */
          }
        })
      } catch (e) {
        try {
          port.postMessage({ event: 'error', data: { message: e.message, code: e.code } })
        } catch {
          /* ignore */
        }
      }
    } else if (msg?.type === 'stop') {
      if (abort) abort.abort()
    }
  })
  port.onDisconnect.addListener(() => {
    if (abort) abort.abort()
  })
})

async function streamChat(payload, signal, emit) {
  const { bridgeUrl, token } = await getConfig()
  const base = trimBase(bridgeUrl)

  let res
  try {
    res = await fetch(base + '/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal,
    })
  } catch (e) {
    if (signal.aborted) return emit('aborted', {})
    throw tagged('bridge_unreachable', `Can't reach the bridge at ${base}. Is it running?`)
  }
  if (res.status === 401) {
    throw tagged('unauthorized', 'Bridge rejected the token (401). Check Settings → Token.')
  }
  if (!res.ok || !res.body) {
    let message = `Bridge error ${res.status}`
    try {
      const j = await res.json()
      message = j.message || message
    } catch {
      /* ignore */
    }
    throw tagged('bridge_error', message)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    let chunk
    try {
      chunk = await reader.read()
    } catch (e) {
      if (signal.aborted) return emit('aborted', {})
      throw e
    }
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    let sep
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      parseSse(buf.slice(0, sep), emit)
      buf = buf.slice(sep + 2)
    }
  }
}

function parseSse(rawEvent, emit) {
  let event = 'message'
  const dataLines = []
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return
  let data = {}
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    /* keep {} */
  }
  emit(event, data)
}

// --- side panel behavior + keyboard command ---

function enablePanelOnActionClick() {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {})
}
chrome.runtime.onInstalled.addListener(enablePanelOnActionClick)
enablePanelOnActionClick()

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'open-with-selection') return
  // CRITICAL: sidePanel.open() must run synchronously inside the user gesture.
  // Any `await` before it (e.g. tabs.query) invalidates the gesture and the
  // open is silently rejected — that was why ⌘⇧L appeared to do nothing.
  // chrome.commands.onCommand hands us the active tab, so no query is needed.
  const tabId = tab && tab.id != null ? tab.id : null
  const windowId = tab && tab.windowId != null ? tab.windowId : null
  if (tabId != null) {
    chrome.sidePanel.open({ tabId }).catch(() => {
      if (windowId != null) chrome.sidePanel.open({ windowId }).catch(() => {})
    })
    chrome.storage.session
      .set({ pendingCapture: { tabId, at: Date.now() } })
      .catch(() => {})
    setTimeout(() => {
      chrome.runtime
        .sendMessage({ kind: 'event', event: 'capture-selection', tabId })
        .catch(() => {})
    }, 150)
    return
  }
  // Rare: the event carried no tab. Best-effort fallback.
  chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
    if (t && t.id != null) chrome.sidePanel.open({ tabId: t.id }).catch(() => {})
  })
})
