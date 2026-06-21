// Runs a single eval case against the REAL Claude adapter.
//
// This is deliberately not a mock: it drives the same runClaude() generator the
// bridge serves in production, so the eval exercises the actual tool gating,
// prompt assembly, and streaming path. We just build a synthetic session and
// collect the streamed events into a RunResult the graders can score.
import { runClaude } from '../bridge/src/adapters/claude.js'
import { buildClaudeTurn } from '../bridge/src/prompt.js'
import { verifyCitations } from '../bridge/src/citations.js'

/**
 * @param {object} spec  one case from cases.json (cwd already resolved/null)
 * @returns {Promise<RunResult>}
 */
export async function runCase(spec) {
  const session = {
    cwd: spec.cwd || null,
    model: spec.model || null,
    claudeSessionId: null, // each case is a fresh conversation
  }

  const { prompt, segments } = buildClaudeTurn({
    message: spec.question,
    quotes: spec.quotes || [],
    title: spec.pageTitle || null,
    url: spec.url || null,
    context: spec.pageContext || null,
    contextSource: spec.contextSource || null,
    includeContext: true,
    history: [],
  })

  const abortController = new AbortController()
  const timeoutMs = spec.timeoutMs || 120_000
  const timer = setTimeout(() => abortController.abort(), timeoutMs)

  const result = {
    answer: '',
    toolCalls: [],
    toolNames: [],
    isError: false,
    error: null,
    aborted: false,
    usage: null,
    costUsd: null,
    durationMs: null,
    numTurns: null,
    citations: null,
  }

  try {
    for await (const ev of runClaude({ session, prompt, abortController })) {
      if (ev.type === 'token') {
        result.answer += ev.text
      } else if (ev.type === 'tool') {
        result.toolCalls.push({ name: ev.name, input: ev.input })
        result.toolNames.push(ev.name)
      } else if (ev.type === 'done') {
        if (ev.text) result.answer = ev.text
        result.isError = Boolean(ev.isError)
        result.usage = ev.usage || null
        result.costUsd = ev.costUsd ?? null
        result.durationMs = ev.durationMs ?? null
        result.numTurns = ev.numTurns ?? null
      } else if (ev.type === 'error') {
        result.error = ev.message
      } else if (ev.type === 'aborted') {
        result.aborted = true
      }
    }
  } catch (e) {
    result.error = String(e?.message || e)
  } finally {
    clearTimeout(timer)
  }

  // Resolve and validate the answer's [n] citations against the page segments.
  result.citations = verifyCitations(result.answer, segments)
  return result
}
