import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCodexPrompt, buildClaudeTurn } from '../src/prompt.js'

const PRIOR = [
  { role: 'user', content: 'what is the codeword' },
  { role: 'assistant', content: 'the codeword is BANANA' },
]

const count = (hay, needle) => hay.split(needle).length - 1

test('codex prompt replays prior turns and includes the new question exactly once', () => {
  const { prompt: p } = buildCodexPrompt({
    session: { cwd: null, messages: PRIOR },
    message: 'NEW_QUESTION_X',
    quotes: [],
  })
  assert.equal(count(p, 'NEW_QUESTION_X'), 1, 'current question must not be duplicated')
  assert.ok(p.includes('<conversation_so_far>'), 'prior turns are replayed')
  assert.ok(p.includes('the codeword is BANANA'), 'prior assistant answer present')
})

test('codex prompt with no prior history has no conversation block and one question', () => {
  const { prompt: p } = buildCodexPrompt({
    session: { cwd: null, messages: [] },
    message: 'NEW_QUESTION_X',
    quotes: [],
  })
  assert.equal(count(p, 'NEW_QUESTION_X'), 1)
  assert.ok(!p.includes('<conversation_so_far>'))
})

test('claude turn replays history only when given (post-backend-switch)', () => {
  const { prompt: withHist } = buildClaudeTurn({
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
  const { prompt: noHist } = buildClaudeTurn({
    message: 'NEW_QUESTION_X',
    quotes: [],
    includeContext: false,
    history: [],
  })
  assert.equal(count(noHist, 'NEW_QUESTION_X'), 1)
  assert.ok(!noHist.includes('<conversation_so_far>'))
})

test('claude turn flags re-included context as updated', () => {
  const { prompt: p } = buildClaudeTurn({
    message: 'NEW_QUESTION_X',
    quotes: [],
    includeContext: true,
    contextUpdated: true,
    context: 'fresh page body',
    title: 'T',
    url: 'https://x',
  })
  assert.ok(p.includes('changed since earlier'), 'notes the content changed')
  assert.ok(p.includes('fresh page body'))
})

test('a turn carrying the page returns a numbered citation segment map', () => {
  const { prompt: p, segments } = buildClaudeTurn({
    message: 'q',
    quotes: [],
    includeContext: true,
    history: [],
    context: 'First paragraph about loopback.\n\nSecond paragraph about tokens.',
    title: 'T',
    url: 'https://x',
  })
  assert.equal(segments.length, 2)
  assert.equal(segments[0].n, 1)
  assert.ok(p.includes('[1] First paragraph'), 'page text is numbered in the prompt')
  assert.ok(p.includes('[2] Second paragraph'))
})

test('a resume turn (no page) returns no segments', () => {
  const { segments } = buildClaudeTurn({
    message: 'q',
    quotes: [],
    includeContext: false,
    history: [],
  })
  assert.deepEqual(segments, [])
})
