// LLM-as-judge grader for open-ended cases (e.g. summary quality) where an
// exact-match assertion is too brittle.
//
// The judge is the same Claude backend, run with NO local access (cwd: null, so
// only web tools exist and it won't touch the filesystem) and a strict rubric.
// It must answer PASS/FAIL on the first line; parseJudgeVerdict (graders.js)
// extracts the verdict. Judging costs a model call, so cases opt in via a
// `judge` block and the whole pass is gated behind --judge on the CLI.
import { runClaude } from '../bridge/src/adapters/claude.js'
import { parseJudgeVerdict } from './graders.js'

function judgePrompt(rubric, question, answer) {
  return [
    'You are a strict grader. Decide whether the ANSWER satisfies the RUBRIC for the QUESTION.',
    'Reply with exactly "PASS" or "FAIL" as the first word, then a one-line reason. Do not be lenient.',
    '',
    `RUBRIC:\n${rubric}`,
    '',
    `QUESTION:\n${question}`,
    '',
    `ANSWER:\n${answer}`,
  ].join('\n')
}

/**
 * Grade one case's answer with the LLM judge.
 * @returns {Promise<GraderResult>}
 */
export async function judgeCase(spec, result) {
  const rubric = spec.judge?.rubric
  if (!rubric) return { name: 'judge', pass: true, detail: 'no rubric (skipped)' }

  const session = { cwd: null, model: spec.judge.model || null, claudeSessionId: null }
  const prompt = judgePrompt(rubric, spec.question, result.answer || '(empty answer)')
  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), spec.judge.timeoutMs || 60_000)

  let verdictText = ''
  let err = null
  try {
    for await (const ev of runClaude({ session, prompt, abortController })) {
      if (ev.type === 'token') verdictText += ev.text
      else if (ev.type === 'done') verdictText = ev.text || verdictText
      else if (ev.type === 'error') err = ev.message
    }
  } catch (e) {
    err = String(e?.message || e)
  } finally {
    clearTimeout(timer)
  }

  if (err) return { name: 'judge', pass: false, detail: `judge error: ${err}` }
  const v = parseJudgeVerdict(verdictText)
  return { name: 'judge', pass: v.pass, detail: v.reason }
}
