// Metrics aggregation + console report for the eval harness.
//
// Pure functions over the array of per-case records produced by run.js, so the
// numbers are reproducible and the formatting is decoupled from execution.

/**
 * Micro-averaged tool-call precision / recall over the cases that declared an
 * `expectTools` set. Precision = how much of what the agent called was wanted;
 * recall = how much of what was wanted got called. Cases with no expectTools
 * are skipped (they make no claim about tools).
 */
export function toolPrecisionRecall(records) {
  let tp = 0
  let predicted = 0
  let expected = 0
  let scored = 0
  for (const r of records) {
    const want = r.spec?.expectTools
    if (!Array.isArray(want) || want.length === 0) continue
    scored++
    const wantSet = new Set(want)
    const gotSet = new Set(r.result?.toolNames || [])
    expected += wantSet.size
    predicted += gotSet.size
    for (const t of gotSet) if (wantSet.has(t)) tp++
  }
  return {
    scoredCases: scored,
    precision: predicted ? tp / predicted : null,
    recall: expected ? tp / expected : null,
  }
}

/** Aggregate pass-rate, per-grader breakdown, tool P/R, cost and latency. */
export function aggregate(records) {
  const total = records.length
  const passed = records.filter((r) => r.passed).length

  // Per-grader pass rates across every case that ran that grader.
  const perGrader = {}
  for (const r of records) {
    for (const g of r.graders || []) {
      const slot = (perGrader[g.name] ||= { pass: 0, total: 0 })
      slot.total++
      if (g.pass) slot.pass++
    }
  }

  const sum = (f) => records.reduce((a, r) => a + (f(r) || 0), 0)
  const costUsd = sum((r) => r.result?.costUsd)
  const durationMs = sum((r) => r.result?.durationMs)
  const usage = records.reduce(
    (a, r) => {
      const u = r.result?.usage
      if (!u) return a
      a.input += u.input_tokens || 0
      a.output += u.output_tokens || 0
      a.cacheRead += u.cache_read_input_tokens || 0
      a.cacheCreate += u.cache_creation_input_tokens || 0
      return a
    },
    { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  )

  return {
    total,
    passed,
    passRate: total ? passed / total : 0,
    perGrader,
    tools: toolPrecisionRecall(records),
    costUsd,
    durationMs,
    usage,
  }
}

const pct = (x) => (x == null ? ' n/a ' : `${(x * 100).toFixed(1)}%`)
const ok = (b) => (b ? '✓ PASS' : '✗ FAIL')

/** Render a human-readable report. Returns a string (no side effects). */
export function formatReport(records, agg) {
  const lines = []
  lines.push('')
  lines.push('═'.repeat(72))
  lines.push('  askd eval results')
  lines.push('═'.repeat(72))

  for (const r of records) {
    lines.push('')
    lines.push(`${ok(r.passed)}  [${r.spec.id}] ${r.spec.title || ''}`)
    for (const g of r.graders || []) {
      lines.push(`        ${g.pass ? '✓' : '✗'} ${g.name}: ${g.detail}`)
    }
    const cost = r.result?.costUsd
    const dur = r.result?.durationMs
    const meta = []
    if (cost != null) meta.push(`$${cost.toFixed(4)}`)
    if (dur != null) meta.push(`${(dur / 1000).toFixed(1)}s`)
    if (r.result?.toolNames?.length) meta.push(`tools: ${r.result.toolNames.join(', ')}`)
    if (meta.length) lines.push(`        · ${meta.join('  ·  ')}`)
  }

  lines.push('')
  lines.push('─'.repeat(72))
  lines.push(`  cases:        ${agg.passed}/${agg.total} passed   (${pct(agg.passRate)})`)
  lines.push(`  tool P / R:   ${pct(agg.tools.precision)} / ${pct(agg.tools.recall)}   (${agg.tools.scoredCases} cases scored)`)
  lines.push(`  tokens:       in ${agg.usage.input}  out ${agg.usage.output}  cacheRead ${agg.usage.cacheRead}`)
  lines.push(`  cost:         $${agg.costUsd.toFixed(4)}`)
  lines.push(`  wall (api):   ${(agg.durationMs / 1000).toFixed(1)}s`)
  lines.push('  per-grader:')
  for (const [name, s] of Object.entries(agg.perGrader)) {
    lines.push(`        ${name}: ${s.pass}/${s.total}  (${pct(s.pass / s.total)})`)
  }
  lines.push('─'.repeat(72))
  lines.push('')
  return lines.join('\n')
}
