// Probe which backend CLIs are available, to drive understandable UI errors.
// (Document fetchers report their own availability via fetchers.js.)
import { spawn } from 'node:child_process'

function probe(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: 'ignore' })
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

export const isClaudeAvailable = () => probe('claude', ['--version'])
export const isCodexAvailable = () => probe('codex', ['--version'])

export async function capabilities() {
  const [claude, codex] = await Promise.all([isClaudeAvailable(), isCodexAvailable()])
  return {
    claude: { available: claude },
    codex: { available: codex, experimental: true },
  }
}
