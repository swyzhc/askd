import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexPrompt, buildClaudeTurn } from '../src/prompt.js'

const PRIOR = [
  { role: 'user', content: 'what is the codeword' },
  { role: 'assistant', content: 'the codeword is BANANA' },
]

const count = (hay, needle) => hay.split(needle).length - 1

test('codex prompt replays prior turns and includes the new question exactly once', () => {
  const p = buildCodexPrompt({
    session: { cwd: null, messages: PRIOR },
    message: 'NEW_QUESTION_X',
    quotes: [],
  })
  assert.equal(count(p, 'NEW_QUESTION_X'), 1, 'current question must not be duplicated')
  assert.ok(p.includes('<conversation_so_far>'), 'prior turns are replayed')
  assert.ok(p.includes('the codeword is BANANA'), 'prior assistant answer present')
})

test('codex prompt with no prior history has no conversation block and one question', () => {
  const p = buildCodexPrompt({
    session: { cwd: null, messages: [] },
    message: 'NEW_QUESTION_X',
    quotes: [],
  })
  assert.equal(count(p, 'NEW_QUESTION_X'), 1)
  assert.ok(!p.includes('<conversation_so_far>'))
})

test('claude turn replays history only when given (post-backend-switch)', () => {
  const withHist = buildClaudeTurn({
    message: 'NEW_QUESTION_X',
    quotes: [],
    includeContext: true,
    history: PRIOR,
  })
  assert.equal(count(withHist, 'NEW_QUESTION_X'), 1)
  assert.ok(withHist.includes('<conversation_so_far>'))
  assert.ok(withHist.includes('the codeword is BANANA'))
})

test('claude resume turn does not replay history', () => {
  const noHist = buildClaudeTurn({
    message: 'NEW_QUESTION_X',
    quotes: [],
    includeContext: false,
    history: [],
  })
  assert.equal(count(noHist, 'NEW_QUESTION_X'), 1)
  assert.ok(!noHist.includes('<conversation_so_far>'))
})
