import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentPage, extractCitations, verifyCitations } from '../src/citations.js'

test('segmentPage numbers blank-line paragraphs and returns a map', () => {
  const { numbered, segments } = segmentPage('Para one is long enough to keep.\n\nPara two is also long enough.')
  assert.equal(segments.length, 2)
  assert.deepEqual(segments.map((s) => s.n), [1, 2])
  assert.ok(numbered.startsWith('[1] Para one'))
  assert.ok(numbered.includes('[2] Para two'))
})

test('segmentPage merges tiny fragments forward instead of numbering them', () => {
  // A short heading should fold into the following substantial paragraph.
  const { segments } = segmentPage('Intro\n\nThis is a substantial paragraph with real content to cite.')
  assert.equal(segments.length, 1)
  assert.ok(segments[0].text.includes('Intro'))
  assert.ok(segments[0].text.includes('substantial paragraph'))
})

test('segmentPage falls back to single lines for an undelimited blob', () => {
  const { segments } = segmentPage('line one is sufficiently long here\nline two is also sufficiently long')
  assert.equal(segments.length, 2)
})

test('segmentPage handles empty input', () => {
  assert.deepEqual(segmentPage(''), { numbered: '', segments: [] })
  assert.deepEqual(segmentPage(null), { numbered: '', segments: [] })
})

test('extractCitations pulls unique numbers in order, ignoring markdown links', () => {
  assert.deepEqual(extractCitations('Grounded [2] and also [5], plus [2] again.'), [2, 5])
  assert.deepEqual(extractCitations('A [link](http://x) is not a citation.'), [])
  assert.deepEqual(extractCitations('Multiple in one: [1, 3].'), [1, 3])
})

test('verifyCitations validates against the segment map and flags hallucinations', () => {
  const segments = [
    { n: 1, text: 'read-only locally' },
    { n: 2, text: 'sent to the cloud' },
  ]
  const r = verifyCitations('It is read-only [1] but data leaves the machine [2].', segments)
  assert.equal(r.validCount, 2)
  assert.equal(r.invalidNumbers.length, 0)
  assert.equal(r.used.find((u) => u.n === 1).text, 'read-only locally')

  const bad = verifyCitations('See [9].', segments)
  assert.deepEqual(bad.invalidNumbers, [9])
  assert.equal(bad.used[0].valid, false)
  assert.equal(bad.used[0].text, null)
})
