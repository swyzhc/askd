// Builds the text turns / prompts sent to the backends.
//
// Claude keeps history server-side (resume), so we only attach the page context
// on the first turn. Codex has no server-side memory, so we splice the whole
// conversation into a single prompt each time.
//
// All size limits are token budgets enforced via ./context.js: the page keeps
// its head AND tail (dropping only the middle), and replayed history is
// compacted to keep recent turns verbatim while collapsing older ones — instead
// of the naive head-truncation that silently dropped a long page's conclusion.
import { clipToTokens, compactConversation, CONTEXT_BUDGET } from './context.js'
import { segmentPage } from './citations.js'

/**
 * Build the <page> block. The page is clipped to the token budget, then split
 * into numbered [1]/[2]/… segments the model is asked to cite. Returns both the
 * block (for the prompt) and the segment map (so the bridge can verify the
 * answer's citations and the UI can resolve [n] back to the source passage).
 * @returns {{ block: string, segments: Array<{ n: number, text: string }> }}
 */
export function pageContextBlock({ title, url, context, contextSource }) {
  if (!context) return { block: '', segments: [] }
  const attrs = [
    contextSource ? ` source=${JSON.stringify(contextSource)}` : '',
    title ? ` title=${JSON.stringify(title)}` : '',
    url ? ` url=${JSON.stringify(url)}` : '',
  ].join('')
  const clipped = clipToTokens(context, CONTEXT_BUDGET.page, { strategy: 'middle' })
  const { numbered, segments } = segmentPage(clipped)
  return { block: `<page${attrs}>\n${numbered}\n</page>`, segments }
}

// Render one or more selected snippets, each as its own <selection> block so
// the model can tell them apart.
export function quotesBlock(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) return ''
  return quotes
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => `<selection>\n${clipToTokens(q, CONTEXT_BUDGET.quote, { strategy: 'head' })}\n</selection>`)
    .join('\n\n')
}

// Replay prior turns as one block, compacted to the history token budget. Used
// wherever there's no server-side resume: always for Codex, and for Claude's
// first turn after a backend switch.
function historyBlock(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const { text } = compactConversation(messages)
  if (!text) return ''
  return `<conversation_so_far>\n${text}\n</conversation_so_far>`
}

/**
 * One user turn for Claude. Page context is included only on the first turn of
 * a conversation (when there's no resume id yet); later turns rely on resume.
 * @returns {{ prompt: string, segments: Array<{ n: number, text: string }> }}
 *   segments is the page's citation map for the turn that carried the page
 *   (empty on resume turns that re-use the server-side context).
 */
export function buildClaudeTurn({
  message,
  quotes,
  title,
  url,
  context,
  contextSource,
  includeContext,
  contextUpdated,
  history,
}) {
  const parts = []
  let segments = []
  if (includeContext) {
    const pc = pageContextBlock({ title, url, context, contextSource })
    if (pc.block) {
      if (contextUpdated) {
        parts.push(
          'The page content has changed since earlier in this conversation. Here is the current version:',
        )
      }
      parts.push(pc.block)
      segments = pc.segments
    }
  }
  // Replay earlier turns when resume isn't available yet (e.g. right after a
  // backend switch) so Claude picks up the thread; normal turns rely on resume.
  const hb = historyBlock(history)
  if (hb) parts.push(hb)
  const qb = quotesBlock(quotes)
  if (qb) parts.push(qb)
  parts.push(message || '')
  return { prompt: parts.join('\n\n'), segments }
}

function codexPersona(hasCwd) {
  const base = [
    'You are askd, a strictly read-only reading assistant embedded in a browser side panel.',
    'Help the user read, explain, summarize, and answer questions about the page/document below.',
    'Do not modify files or the page. Answer in GitHub-flavored Markdown, concisely.',
    'The page is split into numbered segments like [1], [2]. When a statement comes from the page, cite the segment(s) it is grounded in using their bracketed numbers, e.g. [3]. Only cite numbers that appear in the page; do not cite for general knowledge.',
  ]
  base.push(
    hasCwd
      ? 'You were started in a local code directory and may read it to compare documentation against the implementation.'
      : 'You have no local code access for this conversation; answer only from the page content provided.',
  )
  return base.join(' ')
}

/**
 * Codex has no server-side memory, so splice persona + page context + prior
 * turns + the new question into a single prompt.
 * @returns {{ prompt: string, segments: Array<{ n: number, text: string }> }}
 */
export function buildCodexPrompt({
  session,
  message,
  quotes,
  title,
  url,
  context,
  contextSource,
}) {
  const parts = [codexPersona(Boolean(session.cwd))]
  const pc = pageContextBlock({ title, url, context, contextSource })
  if (pc.block) parts.push(pc.block)
  const hb = historyBlock(session.messages)
  if (hb) parts.push(hb)
  const qb = quotesBlock(quotes)
  if (qb) parts.push(qb)
  parts.push(`User: ${message || ''}`)
  parts.push('Assistant:')
  return { prompt: parts.join('\n\n'), segments: pc.segments }
}
