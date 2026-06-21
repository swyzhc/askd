import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateTokens,
  clipToTokens,
  compactConversation,
  CHARS_PER_TOKEN,
  KEEP_RECENT_TURNS,
} from '../src/context.js'

test('estimateTokens uses the chars/4 heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2) // ceil(5/4)
})

test('clipToTokens leaves text that already fits untouched', () => {
  const t = 'short enough'
  assert.equal(clipToTokens(t, 100), t)
})

test('clipToTokens middle strategy keeps the head AND the tail', () => {
  const head = 'HEAD_MARKER'
  const tail = 'TAIL_MARKER'
  const text = head + 'x'.repeat(20_000) + tail
  const out = clipToTokens(text, 500, { strategy: 'middle' })
  assert.ok(out.startsWith(head), 'head preserved')
  assert.ok(out.endsWith(tail), 'tail preserved')
  assert.ok(/omitted ~\d+ tokens from the middle/.test(out), 'has a middle-omission marker')
  assert.ok(out.length < text.length, 'shorter than the original')
})

test('clipToTokens head strategy keeps only the beginning', () => {
  const text = 'BEGIN' + 'y'.repeat(20_000) + 'END'
  const out = clipToTokens(text, 500, { strategy: 'head' })
  assert.ok(out.startsWith('BEGIN'))
  assert.ok(!out.includes('END'))
  assert.ok(/truncated ~\d+ tokens/.test(out))
})

test('clipToTokens roughly respects the budget', () => {
  const text = 'z'.repeat(10_000)
  const out = clipToTokens(text, 100, { strategy: 'head' })
  // Body capped near maxTokens*CHARS_PER_TOKEN; only the short marker is extra.
  assert.ok(out.length <= 100 * CHARS_PER_TOKEN + 80)
})

const turn = (role, content) => ({ role, content })

test('compactConversation returns empty for no messages', () => {
  const r = compactConversation([])
  assert.equal(r.text, '')
  assert.equal(r.keptTurns, 0)
  assert.equal(r.omittedTurns, 0)
})

test('compactConversation keeps everything when under budget', () => {
  const msgs = [turn('user', 'hi'), turn('assistant', 'hello'), turn('user', 'bye')]
  const r = compactConversation(msgs, { maxTokens: 10_000 })
  assert.equal(r.omittedTurns, 0)
  assert.equal(r.keptTurns, 3)
  assert.ok(r.text.includes('User: hi'))
  assert.ok(r.text.includes('Assistant: hello'))
  assert.ok(!r.text.includes('omitted'))
})

test('compactConversation collapses old turns past the budget but keeps recent ones', () => {
  // 10 turns, each ~250 tokens (1000 chars). Tiny budget forces compaction.
  const msgs = Array.from({ length: 10 }, (_, i) =>
    turn(i % 2 ? 'assistant' : 'user', `T${i} ` + 'w'.repeat(1000)),
  )
  const r = compactConversation(msgs, { maxTokens: 300, keepRecentTurns: KEEP_RECENT_TURNS })
  assert.ok(r.omittedTurns > 0, 'some turns omitted')
  assert.ok(r.text.startsWith(`[${r.omittedTurns} earlier turn(s) omitted`), 'leads with the marker')
  // The most recent turns are always kept verbatim.
  assert.ok(r.keptTurns >= KEEP_RECENT_TURNS)
  assert.ok(r.text.includes('T9'), 'newest turn present')
  assert.ok(!r.text.includes('T0 '), 'oldest turn dropped')
})

test('compactConversation keeps the recent window even if it exceeds budget', () => {
  // Each recent turn alone blows the budget, but the recent window is sacred.
  const msgs = Array.from({ length: 6 }, (_, i) => turn('user', `K${i} ` + 'q'.repeat(4000)))
  const r = compactConversation(msgs, { maxTokens: 50, keepRecentTurns: 3 })
  assert.equal(r.keptTurns, 3)
  assert.equal(r.omittedTurns, 3)
  assert.ok(r.text.includes('K5') && r.text.includes('K3'))
  assert.ok(!r.text.includes('K2'))
})
