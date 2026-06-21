// Codex backend adapter (EXPERIMENTAL) — spawns the local `codex` CLI read-only.
//
// Hard argv requirement: the read-only flags must come BEFORE the `exec`
// subcommand:
//     codex --sandbox read-only --ask-for-approval never exec --json ...
//
// `-C <cwd>` is added ONLY when the session has a cwd. When it does not, we
// still neutralize local access by starting the process in an empty dir
// (NO_ACCESS_DIR) so codex's read-only sandbox has nothing to read.
//
// Codex has no server-side memory we reuse, so conversation history is spliced
// into the prompt by the caller (see prompt.buildCodexPrompt).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NO_ACCESS_DIR } from '../config.js'
import { warn } from '../logger.js'

// Build argv with the read-only flags strictly before `exec`.
export function buildCodexArgs({ hasCwd, cwd, lastMessageFile }) {
  const args = [
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    'exec',
    '--json',
    '--skip-git-repo-check',
  ]
  if (hasCwd) args.push('-C', resolve(cwd))
  if (lastMessageFile) args.push('--output-last-message', lastMessageFile)
  args.push('-') // read prompt from stdin
  return args
}

// Tolerant extraction of incremental assistant text across codex JSON shapes.
function extractDelta(obj) {
  if (obj?.msg?.type === 'agent_message_delta' && typeof obj.msg.delta === 'string') {
    return obj.msg.delta
  }
  if (typeof obj?.type === 'string' && /output_text\.delta|item\.delta/.test(obj.type)) {
    if (typeof obj.delta === 'string') return obj.delta
    if (typeof obj.delta?.text === 'string') return obj.delta.text
  }
  return null
}

// Tolerant extraction of a complete assistant message. codex 0.111 emits no
// deltas in `exec --json`; the whole answer arrives in one item.completed:
//   { type:'item.completed', item:{ type:'agent_message', text:'…' } }
function extractFinal(obj) {
  if (obj?.type === 'item.completed' && obj.item) {
    const it = obj.item
    if (
      (it.type === 'agent_message' || it.type === 'assistant_message') &&
      typeof it.text === 'string'
    ) {
      return it.text
    }
  }
  // older shape: { msg:{ type:'agent_message', message:'…' } }
  if (obj?.msg?.type === 'agent_message' && typeof obj.msg.message === 'string') {
    return obj.msg.message
  }
  return null
}

function codexError(e) {
  const msg = String(e?.message || e || '')
  if (e?.code === 'ENOENT' || /ENOENT|not found/i.test(msg)) {
    return 'Codex CLI was not found on PATH. Install it and make sure `codex` runs in a terminal.'
  }
  return `Codex backend error: ${msg}`
}

/**
 * Run one Codex turn. Async generator yielding the same event shape as the
 * Claude adapter: token / tool / done / aborted / error.
 *
 * @param {object} args
 * @param {object} args.session  session record (uses cwd)
 * @param {string} args.prompt   the fully spliced prompt
 * @param {AbortController} args.abortController
 */
export async function* runCodex({ session, prompt, abortController }) {
  const hasCwd = Boolean(session.cwd)
  const spawnCwd = hasCwd ? resolve(session.cwd) : NO_ACCESS_DIR

  const tmpDir = mkdtempSync(join(tmpdir(), 'askd-codex-'))
  const lastMessageFile = join(tmpDir, 'last.txt')
  const args = buildCodexArgs({ hasCwd, cwd: session.cwd, lastMessageFile })

  let child
  let spawnError = null
  try {
    child = spawn('codex', args, {
      cwd: spawnCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    cleanup(tmpDir)
    yield { type: 'error', message: codexError(e) }
    return
  }

  child.on('error', (e) => {
    spawnError = e
  })

  const onAbort = () => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
  if (abortController) {
    if (abortController.signal.aborted) onAbort()
    else abortController.signal.addEventListener('abort', onAbort, { once: true })
  }

  let stderrBuf = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => {
    stderrBuf += d
    const t = String(d).trim()
    if (t) warn('[codex cli]', t.slice(0, 300))
  })

  // Feed the prompt and close stdin.
  try {
    child.stdin.write(prompt)
    child.stdin.end()
  } catch {
    /* if stdin is gone the close handler below reports it */
  }

  let acc = ''
  let finalFromStream = null
  let buf = ''

  try {
    child.stdout.setEncoding('utf8')
    for await (const chunk of child.stdout) {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let obj
        try {
          obj = JSON.parse(line)
        } catch {
          continue // non-JSON progress noise
        }
        const delta = extractDelta(obj)
        if (delta) {
          acc += delta
          yield { type: 'token', text: delta }
        }
        const fin = extractFinal(obj)
        if (fin) {
          finalFromStream = fin
          // No deltas were streamed (this codex version sends the whole message
          // at once) — surface it as a token so the panel renders it live.
          if (acc === '') {
            acc = fin
            yield { type: 'token', text: fin }
          }
        }
      }
    }
  } catch (e) {
    if (!abortController?.signal?.aborted) spawnError = spawnError || e
  }

  // stdout has ended; wait for the process to actually exit.
  const code = await new Promise((r) => {
    if (child.exitCode !== null) return r(child.exitCode)
    child.on('close', (c) => r(c))
  })

  if (abortController) {
    abortController.signal.removeEventListener?.('abort', onAbort)
  }

  if (abortController?.signal?.aborted) {
    cleanup(tmpDir)
    yield { type: 'aborted' }
    return
  }

  if (spawnError) {
    cleanup(tmpDir)
    yield { type: 'error', message: codexError(spawnError) }
    return
  }

  // Authoritative final answer: the --output-last-message file, then any
  // streamed final message, then the accumulated deltas.
  let finalText = ''
  try {
    finalText = readFileSync(lastMessageFile, 'utf8').trim()
  } catch {
    /* file may not exist if codex errored early */
  }
  if (!finalText) finalText = (finalFromStream || acc).trim()
  cleanup(tmpDir)

  if (code !== 0 && !finalText) {
    yield {
      type: 'error',
      message:
        (stderrBuf.trim().slice(0, 600) || `codex exited with code ${code}`) +
        ' (codex support is experimental)',
    }
    return
  }

  // Codex history is prompt-spliced, so there is no native session id to resume.
  yield { type: 'done', sessionId: null, text: finalText || '(no output)', isError: code !== 0 }
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
