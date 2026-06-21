// Token budgeting and conversation compaction for the prompts sent to backends.
//
// askd's Codex path — and the Claude path right after a backend switch — splice
// the whole conversation plus the page content into a single prompt. On a long
// page or a long thread that grows without bound. This module keeps it within a
// token budget the way a main agent loop does:
//
//   1. estimate tokens cheaply (chars/4, the standard rough heuristic);
//   2. keep the highest-value content WHOLE (recent turns, page head + tail);
//   3. COMPACT the rest — drop the middle of a huge page, collapse old turns —
//      instead of hard-truncating the tail (which silently loses conclusions).
//
// Everything here is pure and unit-tested (test/context.test.js) so the
// budgeting logic is verifiable without a model.

export const CHARS_PER_TOKEN = 4

// Per-section token budgets for an assembled prompt. Generous headroom under a
// 200k context window, leaving room for the system prompt and the answer.
export const CONTEXT_BUDGET = Object.freeze({
  page: 25_000, // ~100k chars — the main document
  quote: 5_000, // ~20k chars — user-selected snippets
  history: 8_000, // replayed conversation (Codex / post-switch Claude)
})

// How many of the most recent turns are always kept verbatim, even if doing so
// exceeds the history budget — the recent thread is what the next answer needs.
export const KEEP_RECENT_TURNS = 4

/** Cheap token estimate. Matches the chars/4 heuristic used for budgeting. */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / CHARS_PER_TOKEN)
}

/**
 * Clip text to a token budget.
 *   strategy 'middle' (default): keep the head AND tail, drop the middle. Best
 *     for documents, where the intro and the conclusion both matter.
 *   strategy 'head': keep the beginning only (cheaper; fine for short snippets).
 * Returns the original text untouched when it already fits.
 */
export function clipToTokens(text, maxTokens, { strategy = 'middle' } = {}) {
  if (!text) return ''
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = maxTokens * CHARS_PER_TOKEN

  if (strategy === 'head') {
    const dropped = estimateTokens(text) - maxTokens
    return text.slice(0, maxChars) + `\n\n…[truncated ~${dropped} tokens to fit the context budget]`
  }

  // Keep slightly more head than tail — intros tend to carry more setup.
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = maxChars - headChars
  const omittedTokens = Math.ceil((text.length - maxChars) / CHARS_PER_TOKEN)
  return (
    text.slice(0, headChars) +
    `\n\n…[omitted ~${omittedTokens} tokens from the middle to fit the context budget]…\n\n` +
    text.slice(text.length - tailChars)
  )
}

/** Render one stored turn as a prompt line. */
export function renderTurn(m) {
  return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
}

/**
 * Compact a conversation to fit a token budget. Walks newest→oldest, keeping
 * turns verbatim while they fit; the most recent KEEP_RECENT_TURNS are always
 * kept even if that exceeds the budget. Everything older than the kept window is
 * collapsed into a single "[N earlier turns omitted]" marker.
 *
 * @returns {{ text: string, keptTurns: number, omittedTurns: number }}
 */
export function compactConversation(
  messages,
  { maxTokens = CONTEXT_BUDGET.history, keepRecentTurns = KEEP_RECENT_TURNS } = {},
) {
  const turns = (messages || []).filter((m) => m && typeof m.content === 'string')
  if (turns.length === 0) return { text: '', keptTurns: 0, omittedTurns: 0 }

  const rendered = turns.map(renderTurn)
  const kept = []
  let used = 0
  let omittedTurns = 0

  for (let i = rendered.length - 1; i >= 0; i--) {
    const line = rendered[i]
    const cost = estimateTokens(line)
    const withinRecentWindow = rendered.length - i <= keepRecentTurns
    if (withinRecentWindow || used + cost <= maxTokens) {
      kept.unshift(line)
      used += cost
    } else {
      // Newest→oldest: once one turn doesn't fit, every older turn is omitted too.
      omittedTurns = i + 1
      break
    }
  }

  const parts = []
  if (omittedTurns > 0) {
    parts.push(`[${omittedTurns} earlier turn(s) omitted to fit the context budget]`)
  }
  parts.push(...kept)
  return { text: parts.join('\n\n'), keptTurns: kept.length, omittedTurns }
}
