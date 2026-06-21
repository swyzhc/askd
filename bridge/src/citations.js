// Source attribution ("citations") for page-grounded answers.
//
// The flow, all enforced here so it's testable without a model:
//   1. segmentPage()    numbers the page text [1], [2], … by paragraph, and
//                       returns both the numbered text (sent to the model) and a
//                       segment map (kept by the bridge).
//   2. the model is asked (via the system prompt) to cite claims with [n].
//   3. verifyCitations() parses the answer's [n] refs and checks each against
//                       the map — so a hallucinated number is flagged instead of
//                       silently trusted, and the UI can resolve [n] back to the
//                       exact source passage to highlight.

// Cap so a pathological page can't produce thousands of segments; the overflow
// is merged into the last segment.
const MAX_SEGMENTS = 300
// Paragraphs shorter than this are merged forward, so trivial lines (a lone
// heading, a "—", a stray nav word) don't each burn a citation number. Kept low
// so genuine short sentences still get their own number.
const MIN_SEGMENT_CHARS = 25

/**
 * Split page text into numbered segments.
 * @param {string} text  (already clipped to the token budget by the caller)
 * @returns {{ numbered: string, segments: Array<{ n: number, text: string }> }}
 */
export function segmentPage(text) {
  if (!text || typeof text !== 'string') return { numbered: '', segments: [] }

  // Prefer blank-line-separated paragraphs; fall back to single lines if the
  // text is one undelimited blob.
  let rawParts = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
  if (rawParts.length <= 1) {
    rawParts = text.split(/\n+/).map((s) => s.trim()).filter(Boolean)
  }
  if (rawParts.length === 0) rawParts = [text.trim()]

  // Merge tiny fragments forward so each segment is substantial.
  const merged = []
  for (const part of rawParts) {
    if (merged.length && merged[merged.length - 1].length < MIN_SEGMENT_CHARS) {
      merged[merged.length - 1] += '\n' + part
    } else {
      merged.push(part)
    }
  }

  // Enforce the cap: everything past MAX_SEGMENTS folds into the last one.
  if (merged.length > MAX_SEGMENTS) {
    const tail = merged.slice(MAX_SEGMENTS - 1).join('\n\n')
    merged.length = MAX_SEGMENTS - 1
    merged.push(tail)
  }

  const segments = merged.map((text, i) => ({ n: i + 1, text }))
  const numbered = segments.map((s) => `[${s.n}] ${s.text}`).join('\n\n')
  return { numbered, segments }
}

/** Unique citation numbers referenced in an answer, in first-seen order. */
export function extractCitations(answer) {
  const out = []
  const seen = new Set()
  // Match bracketed bare integers like [2] or [2, 5]; ignore [text](url) links.
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g
  let m
  while ((m = re.exec(String(answer || ''))) !== null) {
    for (const part of m[1].split(',')) {
      const n = Number(part.trim())
      if (Number.isInteger(n) && !seen.has(n)) {
        seen.add(n)
        out.push(n)
      }
    }
  }
  return out
}

/**
 * Resolve and validate an answer's citations against the segment map.
 * @returns {{
 *   used: Array<{ n: number, valid: boolean, text: string|null }>,
 *   invalidNumbers: number[],
 *   validCount: number,
 * }}
 */
export function verifyCitations(answer, segments) {
  const byNumber = new Map((segments || []).map((s) => [s.n, s.text]))
  const refs = extractCitations(answer)
  const used = refs.map((n) => ({
    n,
    valid: byNumber.has(n),
    text: byNumber.has(n) ? byNumber.get(n) : null,
  }))
  const invalidNumbers = used.filter((u) => !u.valid).map((u) => u.n)
  return { used, invalidNumbers, validCount: used.length - invalidNumbers.length }
}
