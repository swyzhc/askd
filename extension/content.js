// Content script: extracts the page's main text and the current selection.
// Runs in an isolated world; `Readability` is provided by vendor/Readability.js
// (injected just before this file). It only READS the DOM — never mutates the
// page, never clicks, never navigates.

const MAX_TEXT_CHARS = 400_000

function getSelectionText() {
  try {
    return String(window.getSelection ? window.getSelection() : '').trim()
  } catch {
    return ''
  }
}

function detectKind() {
  try {
    if (
      document.contentType === 'application/pdf' ||
      /\.pdf($|\?)/i.test(location.href)
    ) {
      return 'pdf'
    }
  } catch {
    /* ignore */
  }
  return 'web'
}

function extractMainText() {
  // Prefer Readability's article extraction; fall back to body innerText.
  let text = ''
  let title = document.title || ''
  let byReadability = false
  try {
    if (typeof Readability === 'function') {
      const article = new Readability(document.cloneNode(true)).parse()
      if (article && article.textContent && article.textContent.trim().length > 200) {
        text = article.textContent.trim()
        if (article.title) title = article.title
        byReadability = true
      }
    }
  } catch {
    /* fall through to innerText */
  }
  if (!text) {
    try {
      text = (document.body ? document.body.innerText : '').trim()
    } catch {
      text = ''
    }
  }
  return { text: text.slice(0, MAX_TEXT_CHARS), title, byReadability }
}

function extractPage() {
  const { text, title, byReadability } = extractMainText()
  return {
    ok: true,
    url: location.href,
    title,
    kind: detectKind(),
    text,
    byReadability,
    selection: getSelectionText(),
    extractedAt: Date.now(),
  }
}

// Scroll to and select a cited passage. Uses the browser's native find, which
// only sets a transient selection and scrolls — it does NOT mutate the DOM, so
// askd stays read-only on the page. We search for a distinctive snippet (the
// first sentence / leading words) because window.find can't match text that
// spans the paragraph breaks Readability collapsed.
function highlightText(text) {
  const snippet = findableSnippet(text)
  if (!snippet || typeof window.find !== 'function') return false
  try {
    window.getSelection()?.removeAllRanges()
    // (string, caseSensitive, backwards, wrapAround)
    return window.find(snippet, false, false, true)
  } catch {
    return false
  }
}

function findableSnippet(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  const sentenceEnd = clean.search(/[.!?]\s/)
  if (sentenceEnd > 20 && sentenceEnd < 120) return clean.slice(0, sentenceEnd + 1)
  return clean.length > 120 ? clean.slice(0, 120) : clean
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.cmd === 'extract') {
    sendResponse(extractPage())
    return // synchronous response
  }
  if (msg.cmd === 'getSelection') {
    sendResponse({ ok: true, selection: getSelectionText() })
    return
  }
  if (msg.cmd === 'highlight') {
    sendResponse({ ok: highlightText(msg.text) })
    return
  }
})
