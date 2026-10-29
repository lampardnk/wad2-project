// Outside services are asked once per question: saved answers, shared lookups, older answers as a fallback
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { startDb, stopDb } from './helpers.js'
import { remembered } from '../cache.js'
import CacheEntry from '../models/CacheEntry.js'
import Attraction from '../models/Attraction.js'
import distanceRoutes from '../routes/distance.js'
import placeRoutes from '../routes/places.js'

const app = express()
app.use('/api/distance-matrix', distanceRoutes)
app.use('/api/places', placeRoutes)
let auth

before(async () => {
  await startDb()
  auth = 'Bearer ' + jwt.sign({ id: '64b000000000000000000000' }, process.env.JWT_SECRET)
})
after(stopDb)

const realFetch = globalThis.fetch
// Fake outside services: count the calls (supertest's own requests go through)
function fakeOutside(answer) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts)
    calls.push(String(url))
    return answer(String(url))
  }
  return calls
}

test('the same question asked twice at once is asked once, then answered from memory', async () => {
  let asked = 0
  const ask = async () => { asked++; return 42 }
  const [a, b] = await Promise.all([remembered('t|same', 60000, ask), remembered('t|same', 60000, ask)])
  assert.equal(a, 42)
  assert.equal(b, 42)
  assert.equal(await remembered('t|same', 60000, ask), 42)
  assert.equal(asked, 1)
  assert.equal((await CacheEntry.findOne({ key: 't|same' })).value, 42) // saved for after a restart
})

test('a saved answer in MongoDB is used without asking', async () => {
  await CacheEntry.create({ key: 't|saved', value: 'from mongo', expiresAt: new Date(Date.now() + 60000) })
  assert.equal(await remembered('t|saved', 60000, async () => 'asked'), 'from mongo')
})

test('when the service fails, the older answer is used', async () => {
  await CacheEntry.create({ key: 't|old', value: 'yesterday', expiresAt: new Date(Date.now() - 1000) })
  assert.equal(await remembered('t|old', 60000, async () => { throw new Error('down') }), 'yesterday')
  await assert.rejects(remembered('t|none', 60000, async () => { throw new Error('down') }))
})

test('Google leg times: the same leg asked by two people costs one Google call', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key'
  const calls = fakeOutside(() => ({ ok: true, json: async () => [{ condition: 'ROUTE_EXISTS', duration: '1440s' }] }))
  try {
    const leg = { origin: 'Taipei 101', destination: 'Lungshan Temple', mode: 'transit' }
    const [a, b] = await Promise.all([1, 2].map(() => request(app).get('/api/distance-matrix').query(leg).set('Authorization', auth)))
    const c = await request(app).get('/api/distance-matrix').query(leg).set('Authorization', auth)
    for (const r of [a, b, c]) assert.equal(r.body.durationText, '24 mins')
    assert.equal(calls.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('popular places: an older saved list is shown at once while it is refreshed in the background', async () => {
  const items = [{ name: 'Taipei 101', type: 'attraction', indoor: false, rank: 1 }]
  await Attraction.create({ key: 'taipei, taiwan', items, fetchedAt: new Date(Date.now() - 40 * 86400000) })
  // The map services hang: the answer must not wait for them
  const calls = fakeOutside(() => new Promise(() => {}))
  try {
    const start = Date.now()
    const [a, b] = await Promise.all([1, 2].map(() => request(app).get('/api/places/attractions').query({ destination: 'Taipei, Taiwan' }).set('Authorization', auth)))
    assert.ok(Date.now() - start < 1000)
    assert.deepEqual(a.body.map((p) => p.name), ['Taipei 101'])
    assert.deepEqual(b.body.map((p) => p.name), ['Taipei 101'])
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(calls.length, 1) // one background refresh for both people
  } finally {
    globalThis.fetch = realFetch
  }
})
