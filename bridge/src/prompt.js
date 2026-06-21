// Builds the text turns / prompts sent to the backends.
//
// Claude keeps history server-side (resume), so we only attach the page context
// on the first turn. Codex has no server-side memory, so we splice the whole
// conversation into a single prompt each time.

const MAX_CONTEXT_CHARS = 100_000
const MAX_QUOTE_CHARS = 20_000

function clip(text, max) {
  if (!text) return ''
  if (text.length <= max) return text
  return text.slice(0, max) + `\n\n…[content truncated at ${max} characters]`
}

export function pageContextBlock({ title, url, context, contextSource }) {
  if (!context) return ''
  const attrs = [
    contextSource ? ` source=${JSON.stringify(contextSource)}` : '',
    title ? ` title=${JSON.stringify(title)}` : '',
    url ? ` url=${JSON.stringify(url)}` : '',
  ].join('')
  return `<page${attrs}>\n${clip(context, MAX_CONTEXT_CHARS)}\n</page>`
}

export function quoteBlock(quote) {
  if (!quote) return ''
  return `<selection>\n${clip(quote, MAX_QUOTE_CHARS)}\n</selection>`
}

/**
 * One user turn for Claude. Page context is included only on the first turn of
 * a conversation (when there's no resume id yet); later turns rely on resume.
 */
export function buildClaudeTurn({
  message,
  quote,
  title,
  url,
  context,
  contextSource,
  includeContext,
}) {
  const parts = []
  if (includeContext) {
    const pc = pageContextBlock({ title, url, context, contextSource })
    if (pc) parts.push(pc)
  }
  const qb = quoteBlock(quote)
  if (qb) parts.push(qb)
  parts.push(message || '')
  return parts.join('\n\n')
}

function codexPersona(hasCwd) {
  const base = [
    'You are askd, a strictly read-only reading assistant embedded in a browser side panel.',
    'Help the user read, explain, summarize, and answer questions about the page/document below.',
    'Do not modify files or the page. Answer in GitHub-flavored Markdown, concisely.',
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
 */
export function buildCodexPrompt({
  session,
  message,
  quote,
  title,
  url,
  context,
  contextSource,
}) {
  const parts = [codexPersona(Boolean(session.cwd))]
  const pc = pageContextBlock({ title, url, context, contextSource })
  if (pc) parts.push(pc)
  if (session.messages && session.messages.length) {
    const hist = session.messages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    parts.push(`<conversation_so_far>\n${hist}\n</conversation_so_far>`)
  }
  const qb = quoteBlock(quote)
  if (qb) parts.push(qb)
  parts.push(`User: ${message || ''}`)
  parts.push('Assistant:')
  return parts.join('\n\n')
}
