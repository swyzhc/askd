// Deterministic graders for the askd eval harness.
//
// Every grader here is a PURE function of (runResult, spec) → GraderResult, so
// the grading logic is unit-tested in CI without ever calling a model
// (see graders.test.js). The model-graded LLM judge lives in judge.js; only its
// verdict PARSING is pure and lives here (parseJudgeVerdict) so it's testable too.
//
// A RunResult is what runner.js collects for one case:
//   { answer, toolCalls:[{name,input}], toolNames:[...], isError, error,
//     aborted, usage, costUsd, durationMs }
//
// A GraderResult is: { name, pass, detail }

/** Coerce a string|string[] spec into a trimmed array. */
function asList(v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' && x.length)
}

/** Every needle must appear in the answer (case-insensitive). */
export function gradeAnswerContains(result, needles) {
  const list = asList(needles)
  const hay = (result.answer || '').toLowerCase()
  const missing = list.filter((n) => !hay.includes(n.toLowerCase()))
  return {
    name: 'answerContains',
    pass: missing.length === 0,
    detail: missing.length ? `missing substrings: ${JSON.stringify(missing)}` : 'all present',
  }
}

/** The answer must match the given regex (source string + flags, default 'i'). */
export function gradeAnswerMatches(result, source, flags = 'i') {
  let re
  try {
    re = new RegExp(source, flags)
  } catch (e) {
    return { name: 'answerMatches', pass: false, detail: `bad regex: ${e.message}` }
  }
  const pass = re.test(result.answer || '')
  return { name: 'answerMatches', pass, detail: pass ? `matched /${source}/${flags}` : `no match for /${source}/${flags}` }
}

/** The answer must NOT match the given regex (e.g. must not claim it edited files). */
export function gradeAnswerNotMatches(result, source, flags = 'i') {
  let re
  try {
    re = new RegExp(source, flags)
  } catch (e) {
    return { name: 'answerNotMatches', pass: false, detail: `bad regex: ${e.message}` }
  }
  const hit = re.test(result.answer || '')
  return { name: 'answerNotMatches', pass: !hit, detail: hit ? `unexpectedly matched /${source}/${flags}` : 'clean' }
}

/** Each named tool must have been called at least once. */
export function gradeExpectTools(result, tools) {
  const want = asList(tools)
  const got = new Set(result.toolNames || [])
  const missing = want.filter((t) => !got.has(t))
  return {
    name: 'expectTools',
    pass: missing.length === 0,
    detail: missing.length ? `tools never called: ${JSON.stringify(missing)}` : `called: ${JSON.stringify([...got])}`,
  }
}

/** None of the named tools may be called (security / read-only assertions). */
export function gradeForbidTools(result, tools) {
  const banned = asList(tools)
  const got = result.toolNames || []
  const violations = banned.filter((t) => got.includes(t))
  return {
    name: 'forbidTools',
    pass: violations.length === 0,
    detail: violations.length ? `FORBIDDEN tools were called: ${JSON.stringify(violations)}` : 'no forbidden tools called',
  }
}

/** The listed tools must appear, in order, as a subsequence of actual calls. */
export function gradeToolOrder(result, order) {
  const want = asList(order)
  const got = result.toolNames || []
  let i = 0
  for (const name of got) {
    if (i < want.length && name === want[i]) i++
  }
  const pass = i === want.length
  return {
    name: 'toolOrder',
    pass,
    detail: pass ? `subsequence satisfied: ${JSON.stringify(want)}` : `expected ${JSON.stringify(want)} as a subsequence of ${JSON.stringify(got)}`,
  }
}

/**
 * The answer must cite the page with valid [n] references. `spec` may be `true`
 * (require ≥1 valid citation and zero hallucinated ones) or `{ min, allowInvalid }`.
 */
export function gradeCitations(result, spec) {
  const opt = spec === true ? {} : spec || {}
  const min = opt.min ?? 1
  const c = result.citations || { validCount: 0, invalidNumbers: [] }
  const enoughValid = c.validCount >= min
  const cleanRefs = opt.allowInvalid ? true : c.invalidNumbers.length === 0
  return {
    name: 'citations',
    pass: enoughValid && cleanRefs,
    detail: `valid=${c.validCount} (need ≥${min}), hallucinated=${JSON.stringify(c.invalidNumbers)}`,
  }
}

/** The run must not have errored (default expectation for every case). */
export function gradeNoError(result) {
  const bad = Boolean(result.isError || result.error || result.aborted)
  return {
    name: 'noError',
    pass: !bad,
    detail: bad ? `run failed: ${result.error || (result.aborted ? 'aborted' : 'is_error')}` : 'ok',
  }
}

/**
 * Parse an LLM judge's reply into a verdict. Convention: the judge replies with
 * PASS or FAIL as the first token, then a one-line reason. Robust to markdown,
 * surrounding prose, and case.
 */
export function parseJudgeVerdict(text) {
  const t = String(text || '')
  const m = /\b(PASS|FAIL)\b/i.exec(t)
  if (!m) return { pass: false, reason: 'judge gave no PASS/FAIL verdict' }
  const verdict = m[1].toUpperCase()
  // Strip everything up to and including the verdict, plus any separator
  // punctuation (colon, dash, em/en dash, etc.) before the reason.
  const reason = t
    .replace(/.*\b(PASS|FAIL)\b[\s:.–—-]*/is, '')
    .split('\n')[0]
    .trim()
  return { pass: verdict === 'PASS', reason: reason || verdict }
}

/**
 * Run every deterministic grader implied by a case spec against a run result.
 * Returns GraderResult[]. The LLM-judge grader (if any) is appended by run.js.
 */
export function runDeterministicGraders(result, spec) {
  const out = []
  // Unless a case opts out, a failed/aborted run fails outright.
  if (spec.allowError !== true) out.push(gradeNoError(result))
  if (spec.expectAnswerContains != null) out.push(gradeAnswerContains(result, spec.expectAnswerContains))
  if (spec.expectAnswerMatches != null) out.push(gradeAnswerMatches(result, spec.expectAnswerMatches, spec.expectAnswerMatchesFlags))
  if (spec.forbidAnswerMatches != null) out.push(gradeAnswerNotMatches(result, spec.forbidAnswerMatches, spec.forbidAnswerMatchesFlags))
  if (spec.expectTools != null) out.push(gradeExpectTools(result, spec.expectTools))
  if (spec.forbidTools != null) out.push(gradeForbidTools(result, spec.forbidTools))
  if (spec.expectToolOrder != null) out.push(gradeToolOrder(result, spec.expectToolOrder))
  if (spec.expectCitations != null) out.push(gradeCitations(result, spec.expectCitations))
  return out
}

/** A case passes iff every grader passed. */
export function casePassed(graderResults) {
  return graderResults.length > 0 && graderResults.every((g) => g.pass)
}
