// Popular places backup (Wikipedia): only real sights, typed by what they are
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wikiKind } from '../routes/places.js'

test('"Ueno Park Building" is not a park', () => {
  assert.equal(wikiKind('Ueno Park Building'), null)
})

test('the last kind word decides the type', () => {
  assert.equal(wikiKind('Meiji Shrine').type, 'heritage')
  assert.equal(wikiKind('Shinjuku Gyoen National Garden').type, 'park')
  assert.equal(wikiKind('Tokyo National Museum').type, 'museum')
})

test('streets and stations are left out', () => {
  assert.equal(wikiKind('Omotesando (street)'), null)
  assert.equal(wikiKind('Harajuku Station'), null)
})

// Photon refusing connections (rate limit) must not break the destination search
test('destination search falls back to Nominatim when Photon is down', async () => {
  const { default: express } = await import('express')
  const { default: request } = await import('supertest')
  const { default: jwt } = await import('jsonwebtoken')
  const { default: placeRoutes } = await import('../routes/places.js')
  const app = express()
  app.use('/api/places', placeRoutes)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).includes('photon')) throw new Error('connect ECONNREFUSED')
    return { ok: true, json: async () => [{ name: 'Taipei', addresstype: 'city', address: { country: 'Taiwan', country_code: 'tw' } }] }
  }
  try {
    process.env.JWT_SECRET = 'test-secret'
    const auth = 'Bearer ' + jwt.sign({ id: '64b000000000000000000000' }, process.env.JWT_SECRET)
    const r = await request(app).get('/api/places').query({ q: 'Taipei' }).set('Authorization', auth)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body[0], { label: 'Taipei, Taiwan', name: 'Taipei', country: 'Taiwan', countryCode: 'TW', type: 'city' })
  } finally {
    globalThis.fetch = realFetch
  }
})
