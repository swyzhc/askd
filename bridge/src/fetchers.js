// Document fetchers — a generic, config-driven plugin mechanism.
//
// A "fetcher" maps a set of hostname patterns to a local CLI command that
// returns Markdown for a URL. This is how askd supports site-specific document
// extraction (e.g. a corporate docs tool) WITHOUT baking any specific tool into
// the core. The core ships no real fetcher; users add their own.
//
// Config is a JSON array, loaded from the first of:
//   1. $ASKD_FETCHERS_FILE
//   2. <data dir>/fetchers.json        (e.g. ~/.askd/fetchers.json — recommended)
//   3. <cwd>/fetchers.json             (repo-local, for development)
//
// Each entry:
//   {
//     "name": "example-docs",
//     "hosts": ["(^|\\.)docs\\.example\\.com$"],      // regex(es), matched against hostname
//     "command": "your-doc-cli",
//     "args": ["fetch", "--url", "{url}", "--format", "markdown"], // {url} is substituted
//     "timeoutMs": 30000
//   }
//
// See fetchers.example.json. Put your real config in ~/.askd/fetchers.json — it
// may reference an internal tool, so it is kept out of the repo (gitignored).
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.js'
import { warn, log } from './logger.js'

const DEFAULT_TIMEOUT_MS = 30_000

let cache = null

function configPaths() {
  const paths = []
  if (process.env.ASKD_FETCHERS_FILE) paths.push(process.env.ASKD_FETCHERS_FILE)
  paths.push(join(DATA_DIR, 'fetchers.json'))
  paths.push(join(process.cwd(), 'fetchers.json'))
  return paths
}

function isValid(f) {
  return (
    f &&
    typeof f.name === 'string' &&
    Array.isArray(f.hosts) &&
    typeof f.command === 'string' &&
    Array.isArray(f.args)
  )
}

function normalize(f) {
  const hostRes = f.hosts
    .map((h) => {
      try {
        return new RegExp(h, 'i')
      } catch {
        warn(`fetcher "${f.name}": invalid host pattern ${JSON.stringify(h)}`)
        return null
      }
    })
    .filter(Boolean)
  return {
    name: f.name,
    hosts: f.hosts,
    command: f.command,
    args: f.args,
    timeoutMs: typeof f.timeoutMs === 'number' ? f.timeoutMs : DEFAULT_TIMEOUT_MS,
    hostRes,
  }
}

export function loadFetchers(force = false) {
  if (cache && !force) return cache
  cache = []
  for (const p of configPaths()) {
    if (!existsSync(p)) continue
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8'))
      if (Array.isArray(parsed)) {
        cache = parsed.filter(isValid).map(normalize)
        log(`loaded ${cache.length} document fetcher(s) from ${p}`)
        break
      }
      warn(`fetchers config at ${p} is not a JSON array; ignoring`)
    } catch (e) {
      warn(`fetchers config unreadable at ${p}: ${e.message}`)
    }
  }
  return cache
}

/** Find the fetcher whose host patterns match this URL, or null. */
export function getFetcherForUrl(url) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  for (const f of loadFetchers()) {
    if (f.hostRes.some((re) => re.test(host))) return f
  }
  return null
}

/** Public view: names + host patterns (so the extension knows when to try one). */
export function listFetchers() {
  return loadFetchers().map((f) => ({ name: f.name, hosts: f.hosts }))
}

/**
 * Run a fetcher for a URL.
 * @returns {Promise<{ok:true, markdown, fetcher} | {ok:false, code, message}>}
 *   code ∈ fetcher_missing | scope_missing | auth_required | doc_not_found | timeout | fetch_failed
 */
export function runFetcher(fetcher, url) {
  return new Promise((resolve) => {
    const args = fetcher.args.map((a) => a.split('{url}').join(url))
    let child
    try {
      child = spawn(fetcher.command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({
        ok: false,
        code: 'fetcher_missing',
        message: `${fetcher.command} is not installed or not on PATH.`,
      })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ ok: false, code: 'timeout', message: `${fetcher.command} timed out.` })
    }, fetcher.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) =>
      finish(
        e.code === 'ENOENT'
          ? {
              ok: false,
              code: 'fetcher_missing',
              message: `${fetcher.command} is not installed or not on PATH.`,
            }
          : { ok: false, code: 'fetch_failed', message: e.message },
      ),
    )
    child.on('close', (code) => {
      if (code === 0 && out.trim()) {
        finish({ ok: true, markdown: out, fetcher: fetcher.name })
        return
      }
      const blob = `${err}\n${out}`.toLowerCase()
      let errCode = 'fetch_failed'
      if (/scope|permission|forbidden|403/.test(blob)) errCode = 'scope_missing'
      else if (/login|auth|token|credential|401|unauthor/.test(blob)) errCode = 'auth_required'
      else if (/not found|404|no such|does not exist/.test(blob)) errCode = 'doc_not_found'
      finish({
        ok: false,
        code: errCode,
        message: (err || out || `${fetcher.command} failed`).trim().slice(0, 800),
      })
    })
  })
}

function probe(cmd) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, ['--version'], { stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const done = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    child.on('error', () => done(false))
    child.on('close', (code) => done(code === 0))
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      done(false)
    }, 4000)
  })
}

/** Per-fetcher availability (is its command installed?), for /api/info. */
export async function fetcherAvailability() {
  const fetchers = loadFetchers()
  return Promise.all(
    fetchers.map((f) =>
      probe(f.command).then((available) => ({ name: f.name, available })),
    ),
  )
}
