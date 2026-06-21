import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrlKey } from '../src/urlkey.js'

test('trailing slash does not fork a session', () => {
  assert.equal(
    normalizeUrlKey('https://example.com/docs/guide/'),
    normalizeUrlKey('https://example.com/docs/guide'),
  )
})

test('host casing and default ports are normalized', () => {
  assert.equal(
    normalizeUrlKey('https://Example.COM:443/a'),
    normalizeUrlKey('https://example.com/a'),
  )
  assert.equal(
    normalizeUrlKey('http://example.com:80/a'),
    normalizeUrlKey('http://example.com/a'),
  )
})

test('plain anchor fragments are ignored', () => {
  assert.equal(
    normalizeUrlKey('https://example.com/post#section-3'),
    normalizeUrlKey('https://example.com/post'),
  )
})

test('hash routes are kept distinct (SPA routing)', () => {
  assert.notEqual(
    normalizeUrlKey('https://app.example.com/#/inbox'),
    normalizeUrlKey('https://app.example.com/#/settings'),
  )
})

test('tracking params are stripped', () => {
  assert.equal(
    normalizeUrlKey('https://example.com/p?utm_source=x&utm_medium=y&id=42'),
    normalizeUrlKey('https://example.com/p?id=42'),
  )
})

test('query param order does not matter', () => {
  assert.equal(
    normalizeUrlKey('https://example.com/p?b=2&a=1'),
    normalizeUrlKey('https://example.com/p?a=1&b=2'),
  )
})

test('meaningful query params keep pages distinct', () => {
  assert.notEqual(
    normalizeUrlKey('https://example.com/doc?id=1'),
    normalizeUrlKey('https://example.com/doc?id=2'),
  )
})

test('different paths never collide', () => {
  assert.notEqual(
    normalizeUrlKey('https://example.com/a'),
    normalizeUrlKey('https://example.com/b'),
  )
})

test('different hosts never collide', () => {
  assert.notEqual(
    normalizeUrlKey('https://a.example.com/p'),
    normalizeUrlKey('https://b.example.com/p'),
  )
})

test('path stays case-sensitive (servers treat it so)', () => {
  assert.notEqual(
    normalizeUrlKey('https://example.com/Guide'),
    normalizeUrlKey('https://example.com/guide'),
  )
})

test('doc URL is stable across tracking noise', () => {
  // utm_* is stripped; a genuine param like ?from=space is kept (conservative:
  // we don't strip ambiguous params that some sites use meaningfully).
  assert.equal(
    normalizeUrlKey('https://docs.example.com/d/AbCd1234?utm_source=share'),
    normalizeUrlKey('https://docs.example.com/d/AbCd1234'),
  )
  assert.notEqual(
    normalizeUrlKey('https://docs.example.com/d/AbCd1234?from=space'),
    normalizeUrlKey('https://docs.example.com/d/AbCd1234'),
  )
})

test('non-URL input is handled deterministically', () => {
  assert.equal(normalizeUrlKey('not a url'), normalizeUrlKey('NOT A URL'))
  assert.equal(normalizeUrlKey(''), 'invalid:')
  assert.equal(normalizeUrlKey(null), 'invalid:')
})
