// Unit tests for the grading logic. These run in CI WITHOUT calling any model —
// they feed synthetic RunResults to the pure graders and assert the verdicts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gradeAnswerContains,
  gradeAnswerMatches,
  gradeExpectTools,
  gradeForbidTools,
  gradeToolOrder,
  gradeCitations,
  gradeNoError,
  parseJudgeVerdict,
  runDeterministicGraders,
  casePassed,
} from './graders.js'
import { toolPrecisionRecall, aggregate } from './report.js'

const base = { answer: '', toolNames: [], toolCalls: [], isError: false, error: null, aborted: false }

test('answerContains needs every substring, case-insensitive', () => {
  const r = { ...base, answer: 'Binds 127.0.0.1 on port 8765.' }
  assert.equal(gradeAnswerContains(r, ['127.0.0.1', '8765']).pass, true)
  assert.equal(gradeAnswerContains(r, ['127.0.0.1', '9999']).pass, false)
})

test('answerMatches honours regex + default i flag', () => {
  const r = { ...base, answer: 'It is strictly READ-ONLY.' }
  assert.equal(gradeAnswerMatches(r, 'read.?only').pass, true)
  assert.equal(gradeAnswerMatches(r, '\\bbash\\b').pass, false)
})

test('expectTools fails when a wanted tool was never called', () => {
  const r = { ...base, toolNames: ['Grep'] }
  assert.equal(gradeExpectTools(r, ['Grep']).pass, true)
  assert.equal(gradeExpectTools(r, ['Read']).pass, false)
})

test('forbidTools fails the instant a banned tool appears', () => {
  assert.equal(gradeForbidTools({ ...base, toolNames: ['Read'] }, ['Write']).pass, true)
  assert.equal(gradeForbidTools({ ...base, toolNames: ['Write'] }, ['Write', 'Bash']).pass, false)
})

test('toolOrder checks subsequence, not contiguity', () => {
  const r = { ...base, toolNames: ['Grep', 'Read', 'Read'] }
  assert.equal(gradeToolOrder(r, ['Grep', 'Read']).pass, true)
  assert.equal(gradeToolOrder(r, ['Read', 'Grep']).pass, false)
})

test('gradeCitations needs valid refs and no hallucinations', () => {
  const good = { ...base, citations: { validCount: 2, invalidNumbers: [] } }
  assert.equal(gradeCitations(good, true).pass, true)
  const none = { ...base, citations: { validCount: 0, invalidNumbers: [] } }
  assert.equal(gradeCitations(none, true).pass, false)
  const hallucinated = { ...base, citations: { validCount: 1, invalidNumbers: [9] } }
  assert.equal(gradeCitations(hallucinated, true).pass, false)
  assert.equal(gradeCitations(hallucinated, { allowInvalid: true }).pass, true)
})

test('noError catches is_error, error string, and abort', () => {
  assert.equal(gradeNoError(base).pass, true)
  assert.equal(gradeNoError({ ...base, isError: true }).pass, false)
  assert.equal(gradeNoError({ ...base, error: 'boom' }).pass, false)
  assert.equal(gradeNoError({ ...base, aborted: true }).pass, false)
})

test('parseJudgeVerdict extracts PASS/FAIL and reason', () => {
  assert.deepEqual(parseJudgeVerdict('PASS — covers both points'), { pass: true, reason: 'covers both points' })
  assert.equal(parseJudgeVerdict('FAIL: omits the cloud point').pass, false)
  assert.equal(parseJudgeVerdict('no verdict here').pass, false)
})

test('runDeterministicGraders + casePassed compose the per-case verdict', () => {
  const r = { ...base, answer: 'safety.js allows Read, Glob, Grep', toolNames: ['Grep'] }
  const spec = { expectAnswerContains: 'safety.js', expectTools: ['Grep'], forbidTools: ['Write'] }
  const graders = runDeterministicGraders(r, spec)
  assert.equal(casePassed(graders), true)

  const bad = runDeterministicGraders({ ...r, toolNames: ['Write'] }, spec)
  assert.equal(casePassed(bad), false) // forbidTools tripped
})

test('toolPrecisionRecall micro-averages over expectTools cases', () => {
  const records = [
    { spec: { expectTools: ['Grep'] }, result: { toolNames: ['Grep', 'Read'] } }, // tp1, pred2, exp1
    { spec: { expectTools: ['Read'] }, result: { toolNames: ['Read'] } }, // tp1, pred1, exp1
    { spec: {}, result: { toolNames: ['Bash'] } }, // skipped (no expectTools)
  ]
  const pr = toolPrecisionRecall(records)
  assert.equal(pr.scoredCases, 2)
  assert.equal(pr.precision, 2 / 3) // 2 tp / 3 predicted
  assert.equal(pr.recall, 1) // 2 tp / 2 expected
})

test('aggregate computes pass rate and sums cost/tokens', () => {
  const records = [
    { passed: true, graders: [{ name: 'noError', pass: true }], spec: {}, result: { costUsd: 0.01, durationMs: 1000, usage: { input_tokens: 100, output_tokens: 20 } } },
    { passed: false, graders: [{ name: 'noError', pass: false }], spec: {}, result: { costUsd: 0.02, durationMs: 2000, usage: { input_tokens: 50, output_tokens: 10 } } },
  ]
  const agg = aggregate(records)
  assert.equal(agg.total, 2)
  assert.equal(agg.passed, 1)
  assert.equal(agg.passRate, 0.5)
  assert.equal(Math.round(agg.costUsd * 100) / 100, 0.03)
  assert.equal(agg.usage.input, 150)
  assert.equal(agg.usage.output, 30)
})
