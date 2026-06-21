// HTTP helpers: CORS, bearer auth, body parsing, SSE.
import { timingSafeEqual } from 'node:crypto'

const MAX_BODY_BYTES = 8 * 1024 * 1024 // 8 MB — page context can be large

// CORS: allow only Chrome extension origins, per the security requirements.
// Requests with no Origin (curl, health checks) are allowed through here; the
// bearer token is the real gate for everything except /healthz.
export function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && origin.startsWith('chrome-extension://')) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    )
    res.setHeader('Access-Control-Max-Age', '600')
  }
  return origin
}

// Is this a Chrome extension origin (or an origin-less local request)?
export function isAllowedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  return origin.startsWith('chrome-extension://')
}

export function handlePreflight(req, res) {
  applyCors(req, res)
  res.writeHead(204)
  res.end()
}

// Constant-time bearer token check.
export function checkAuth(req, expectedToken) {
  const header = req.headers.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(header)
  if (!m) return false
  const provided = Buffer.from(m[1].trim(), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message: message || code })
}

// Read and JSON-parse a request body with a size cap.
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// --- Server-Sent Events ---

export function startSse(req, res) {
  applyCors(req, res)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // Prime the stream so the client's reader resolves immediately.
  res.write(': askd stream open\n\n')
}

export function sseSend(res, event, data) {
  if (res.writableEnded) return
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export function sseClose(res) {
  if (!res.writableEnded) res.end()
}
