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

test('encoded separators in a query value do not collide with real separators', () => {
  // ?a=1%26b%3D2 is ONE param whose value literally contains "&" and "=";
  // ?a=1&b=2 is TWO params. They must never share a session key.
  const encoded = normalizeUrlKey('https://example.com/p?a=1%26b%3D2')
  const plain = normalizeUrlKey('https://example.com/p?a=1&b=2')
  assert.notEqual(encoded, plain)
  // Reserved characters stay percent-encoded in the key instead of leaking
  // raw separators that would make the query ambiguous.
  assert.equal(encoded, 'https://example.com/p?a=1%26b%3D2')
})

test('encoded separators in a query key do not collide with real separators', () => {
  assert.notEqual(
    normalizeUrlKey('https://example.com/p?a%26b=1'),
    normalizeUrlKey('https://example.com/p?a&b=1'),
  )
})

test('equivalent query encodings still share a session', () => {
  // %20 and + both decode to a space: same logical param, same key.
  assert.equal(
    normalizeUrlKey('https://example.com/p?q=a%20b'),
    normalizeUrlKey('https://example.com/p?q=a+b'),
  )
})

test('encoded query values survive sorting and tracking removal', () => {
  assert.equal(
    normalizeUrlKey('https://example.com/p?b=2&a=1%26x%3D3&utm_source=z'),
    normalizeUrlKey('https://example.com/p?a=1%26x%3D3&b=2'),
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
