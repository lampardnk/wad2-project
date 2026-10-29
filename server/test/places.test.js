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

// These two run before any test makes Photon fail (a failure makes it skipped for 5 minutes)
test('healthy Photon answers alone: the backup is never asked', async () => {
  const { photonOrBackup } = await import('../routes/places.js')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ features: ['photon'] }) })
  let backupAsked = false
  try {
    const data = await photonOrBackup({ q: 'Taipei' }, async () => { backupAsked = true; return { features: ['backup'] } })
    assert.deepEqual(data.features, ['photon'])
    await new Promise((resolve) => setTimeout(resolve, 2200)) // past the 2 s mark
    assert.equal(backupAsked, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('slow Photon: the backup is asked after 2 s and its answer is used', async () => {
  const { photonOrBackup } = await import('../routes/places.js')
  const realFetch = globalThis.fetch
  let photonCancelled = false
  // Photon hangs until it is cancelled
  globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { photonCancelled = true; reject(new Error('aborted')) })
  })
  try {
    const start = Date.now()
    const data = await photonOrBackup({ q: 'Lungshan Temple' }, async () => ({ features: ['backup'] }))
    const took = Date.now() - start
    assert.deepEqual(data.features, ['backup'])
    assert.ok(took >= 1900 && took < 3000, 'took ' + took + ' ms')
    assert.equal(photonCancelled, true)
  } finally {
    globalThis.fetch = realFetch
  }
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

// Nominatim's usage policy: at most one request a second
test('Nominatim calls are spaced at least a second apart', async () => {
  const { nominatim } = await import('../routes/places.js')
  const realFetch = globalThis.fetch
  const times = []
  globalThis.fetch = async () => { times.push(Date.now()); return { ok: true, json: async () => [] } }
  try {
    await Promise.all([nominatim({ q: 'a' }), nominatim({ q: 'b' }), nominatim({ q: 'c' })])
    assert.equal(times.length, 3)
    assert.ok(times[1] - times[0] >= 1000 && times[2] - times[1] >= 1000)
  } finally {
    globalThis.fetch = realFetch
  }
})

// Runs after the destination test above made Photon fail
test('after Photon fails it is skipped: the backup answers straight away', async () => {
  const { photonOrBackup } = await import('../routes/places.js')
  const realFetch = globalThis.fetch
  let photonAsked = false
  globalThis.fetch = async () => { photonAsked = true; return { ok: true, json: async () => ({ features: ['photon'] }) } }
  try {
    const start = Date.now()
    const data = await photonOrBackup({ q: 'Taipei' }, async () => ({ features: ['backup'] }))
    assert.deepEqual(data.features, ['backup'])
    assert.equal(photonAsked, false)
    assert.ok(Date.now() - start < 500)
  } finally {
    globalThis.fetch = realFetch
  }
})

// Someone typing a search goes ahead of background lookups (map pins) waiting for Nominatim
test('an urgent Nominatim call jumps the queue of background lookups', async () => {
  const { nominatim } = await import('../routes/places.js')
  const realFetch = globalThis.fetch
  const order = []
  globalThis.fetch = async (url) => { order.push(new URL(url).searchParams.get('q')); return { ok: true, json: async () => [] } }
  try {
    const background = ['pin1', 'pin2', 'pin3'].map((q) => nominatim({ q }))
    await new Promise((resolve) => setTimeout(resolve, 50)) // the pins are waiting their turn
    await Promise.all([...background, nominatim({ q: 'typed' }, null, { urgent: true })])
    // At most one pin (the one already on its way) goes before the typed search
    assert.ok(order.indexOf('typed') <= 1, order.join(', '))
    assert.ok(order.indexOf('typed') < order.indexOf('pin2'))
  } finally {
    globalThis.fetch = realFetch
  }
})
