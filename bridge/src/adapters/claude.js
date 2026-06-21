// Claude backend adapter (via @anthropic-ai/claude-agent-sdk).
//
// Security posture (enforced three independent ways):
//   1. `tools`           — the base set only contains the read-only tools we
//                          want, so write/shell tools never exist in context.
//   2. allow/disallow    — explicit allow-list plus a disallow-list of the
//                          write/shell tools (Edit/Write/NotebookEdit/Bash).
//   3. canUseTool        — a runtime gate that denies anything off-policy and
//                          confines Read/Glob/Grep to the session's cwd.
//
// When a session has no cwd, it gets NO file tools at all, and we run the
// subprocess in an empty NO_ACCESS_DIR so the SDK can never fall back to the
// bridge's own process.cwd().
import { isAbsolute, resolve } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import {
  FORBIDDEN_TOOLS,
  FILE_TOOLS,
  WEB_TOOLS,
  allowedToolsFor,
  disallowedToolsFor,
  isInsideRoot,
  pathFromToolInput,
} from '../safety.js'
import { NO_ACCESS_DIR } from '../config.js'
import { warn } from '../logger.js'

function systemPrompt(hasCwd) {
  const base = [
    'You are askd, a read-only reading assistant embedded in a Chrome side panel.',
    'You help the user read, explain, summarize, and answer questions about the web page or document they are viewing, and compare it against their local code when a directory is available.',
    'You are strictly read-only: you cannot edit or write files, run shell commands, or operate the web page. Never claim to have changed anything.',
    'Answer in GitHub-flavored Markdown. Be concise and concrete. When you reference code, cite file paths and line numbers.',
  ]
  base.push(
    hasCwd
      ? 'A local code directory is available. You may use Read, Glob, and Grep (read-only) to inspect it, plus WebFetch and WebSearch. Stay within the provided directory.'
      : 'No local code directory is configured for this session, so you have NO file access. Answer only from the page content provided and, if needed, WebFetch / WebSearch.',
  )
  return base.join('\n')
}

// Runtime permission gate — the last line of defense.
function buildCanUseTool(session) {
  const hasCwd = Boolean(session.cwd)
  const root = hasCwd ? resolve(session.cwd) : null
  return async (toolName, input) => {
    if (FORBIDDEN_TOOLS.includes(toolName)) {
      return { behavior: 'deny', message: `askd is read-only; ${toolName} is disabled.` }
    }
    if (FILE_TOOLS.includes(toolName)) {
      if (!hasCwd) {
        return {
          behavior: 'deny',
          message:
            'This session has no local code access. Set a working directory to read files.',
        }
      }
      const p = pathFromToolInput(toolName, input)
      if (p) {
        const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
        if (!isInsideRoot(root, abs)) {
          return {
            behavior: 'deny',
            message: `Path is outside the session root (${root}).`,
          }
        }
      }
      return { behavior: 'allow' }
    }
    if (WEB_TOOLS.includes(toolName)) {
      return { behavior: 'allow' }
    }
    return { behavior: 'deny', message: `Tool ${toolName} is not permitted in askd.` }
  }
}

const AUTH_HELP =
  "Claude Code isn't logged in on this machine. Open a terminal, run `claude`, sign in, then retry. (askd uses your local Claude Code login — it has no API key of its own.)"

// The Claude CLI sometimes reports auth failure as plain text — e.g.
// "Not logged in. Please run /login" — via the result message rather than a
// thrown error, so we detect it on both paths.
function looksLikeAuthError(text) {
  return /not logged in|run\s+\/login|invalid api key|unauthorized|authentication_error|no .*api key/i.test(
    text || '',
  )
}

function humanizeClaudeError(e) {
  const msg = String(e?.message || e || '')
  if (/ENOENT|not found|command not found/i.test(msg)) {
    return 'Claude Code CLI was not found on PATH. Install it and make sure `claude` runs in a terminal.'
  }
  if (/not.*log|auth|credential|unauthor|401|\/login/i.test(msg)) {
    return AUTH_HELP
  }
  return `Claude backend error: ${msg}`
}

/**
 * Run one Claude turn. Async generator yielding:
 *   { type: 'token', text }
 *   { type: 'tool', name, input }
 *   { type: 'done', sessionId, text, isError }
 *   { type: 'aborted' }
 *   { type: 'error', message }
 *
 * @param {object} args
 * @param {object} args.session   session record (uses cwd, model, claudeSessionId)
 * @param {string} args.prompt    the user turn text
 * @param {AbortController} args.abortController
 */
export async function* runClaude({ session, prompt, abortController }) {
  const hasCwd = Boolean(session.cwd)
  // Explicit cwd: the real root when set, else an empty dir we control. Never
  // left to default to the bridge's process.cwd().
  const cwd = hasCwd ? resolve(session.cwd) : NO_ACCESS_DIR

  const options = {
    cwd,
    tools: allowedToolsFor(hasCwd),
    allowedTools: allowedToolsFor(hasCwd),
    disallowedTools: disallowedToolsFor(hasCwd),
    // Load ONLY user-level settings (~/.claude/settings.json) so auth helpers
    // like `apiKeyHelper` (common in corporate setups) are picked up — with `[]`
    // (full isolation) those users get "Not logged in" even though `claude` works
    // in a terminal. 'project'/'local' stay excluded, so no repo CLAUDE.md or
    // project rules leak into the assistant. (Tool gating is unaffected: the
    // read-only allow-list + canUseTool default-deny still cap everything.)
    settingSources: ['user'],
    includePartialMessages: true,
    canUseTool: buildCanUseTool(session),
    permissionMode: 'default',
    systemPrompt: systemPrompt(hasCwd),
    abortController,
    stderr: (d) => {
      const t = String(d).trim()
      if (t) warn('[claude cli]', t)
    },
  }
  if (session.model) options.model = session.model
  if (session.claudeSessionId) options.resume = session.claudeSessionId

  let finalSessionId = session.claudeSessionId || null
  let acc = ''

  try {
    const q = query({ prompt, options })
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (
          ev?.type === 'content_block_delta' &&
          ev.delta?.type === 'text_delta' &&
          typeof ev.delta.text === 'string'
        ) {
          acc += ev.delta.text
          yield { type: 'token', text: ev.delta.text }
        }
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content || []) {
          if (block.type === 'tool_use') {
            yield { type: 'tool', name: block.name, input: block.input }
          }
        }
        if (msg.session_id) finalSessionId = msg.session_id
      } else if (msg.type === 'result') {
        if (msg.session_id) finalSessionId = msg.session_id
        const text =
          (typeof msg.result === 'string' && msg.result) || acc || '(no output)'
        // Surface a clean, actionable message instead of the raw CLI auth text.
        if (looksLikeAuthError(text)) {
          yield { type: 'error', message: AUTH_HELP }
          return
        }
        yield {
          type: 'done',
          sessionId: finalSessionId,
          text,
          isError: Boolean(msg.is_error),
        }
        return
      }
    }
    // Stream ended without an explicit result message.
    yield { type: 'done', sessionId: finalSessionId, text: acc, isError: false }
  } catch (e) {
    if (abortController?.signal?.aborted) {
      yield { type: 'aborted' }
      return
    }
    yield { type: 'error', message: humanizeClaudeError(e) }
  }
}
