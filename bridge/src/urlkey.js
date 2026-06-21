// URL -> stable session key normalization.
//
// Goals:
//   - The same logical page maps to ONE key (so history is remembered across
//     trivial URL differences: trailing slash, tracking params, param order,
//     anchor fragments, host casing, default ports).
//   - Genuinely different URLs map to DIFFERENT keys (so sessions never cross:
//     different path, different host, different meaningful query, or different
//     hash *route*).
//
// This is deliberately conservative: when in doubt we keep a distinction rather
// than merge two pages into one conversation.

// Query parameters that identify the *visit*, not the *resource*. Dropping them
// keeps the same article from forking into many sessions.
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'dclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'referrer',
  'source',
  'spm',
  'scm',
  '_hsenc',
  '_hsmi',
])

/**
 * Normalize a raw URL string into a stable session key.
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeUrlKey(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return 'invalid:'
  }
  let u
  try {
    u = new URL(rawUrl)
  } catch {
    // Not a parseable URL — fall back to a stable, lowercased literal so two
    // identical inputs still collide but distinct ones don't.
    return 'invalid:' + rawUrl.trim().toLowerCase()
  }

  const scheme = u.protocol.toLowerCase() // includes trailing ':'
  const host = u.hostname.toLowerCase()

  // Drop default ports so https://h:443/ === https://h/
  let port = u.port
  if (
    (scheme === 'http:' && port === '80') ||
    (scheme === 'https:' && port === '443')
  ) {
    port = ''
  }

  // Path: strip trailing slashes but keep root '/'.
  let path = u.pathname || '/'
  if (path.length > 1) path = path.replace(/\/+$/, '')
  if (path === '') path = '/'

  // Query: drop tracking params, then sort for order-independence.
  const params = []
  for (const [k, v] of u.searchParams.entries()) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue
    params.push([k, v])
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  const qs = params.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&')

  // Fragment: keep hash *routes* (#/foo — SPA routing identifies the page) but
  // drop plain anchors (#section — same page, different scroll position).
  let frag = ''
  if (u.hash && u.hash.startsWith('#/')) {
    frag = u.hash
  }

  const portPart = port ? `:${port}` : ''
  let key = `${scheme}//${host}${portPart}${path}`
  if (qs) key += `?${qs}`
  if (frag) key += frag
  return key
}
