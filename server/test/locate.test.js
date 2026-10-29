// Map pins: each place is looked up once, even when the trip page asks again or two people ask at once
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { startDb, stopDb } from './helpers.js'
import safetyRoutes from '../routes/safety.js'
import PlaceLookup from '../models/PlaceLookup.js'

const app = express()
app.use('/api/safety', safetyRoutes)
let auth

before(async () => {
  await startDb()
  auth = 'Bearer ' + jwt.sign({ id: '64b000000000000000000000' }, process.env.JWT_SECRET)
})
after(stopDb)

// Fake map services: count the calls, answer with `features`
const realFetch = globalThis.fetch
function fakeMaps(features) {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts) // supertest's own requests
    calls.push(String(url))
    return { ok: true, json: async () => ({ features }) }
  }
  return calls
}
const taipei101 = { geometry: { coordinates: [121.5645, 25.0340] }, properties: { name: 'Taipei 101', city: 'Taipei', country: 'Taiwan', countrycode: 'TW' } }
const locate = (place) => request(app).get('/api/safety/locate').query({ place }).set('Authorization', auth)

test('two people asking at once share one lookup', async () => {
  const calls = fakeMaps([taipei101])
  try {
    const [a, b] = await Promise.all([locate('Taipei 101'), locate('Taipei 101')])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.body.city, 'Taipei')
    assert.equal(calls.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a place that is not found is not asked about again', async () => {
  const calls = fakeMaps([])
  try {
    assert.equal((await locate('Nowhere Tower')).status, 404)
    const asked = calls.length
    assert.equal((await locate('Nowhere Tower')).status, 404)
    assert.equal(calls.length, asked)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('found places are saved in MongoDB and used from there', async () => {
  await PlaceLookup.create({ key: 'fubon life tower|', place: { lat: 25.04, lon: 121.56, city: 'Taipei', countryCode: 'TW', countryName: 'Taiwan' } })
  const calls = fakeMaps([])
  try {
    const r = await locate('Fubon Life Tower')
    assert.equal(r.status, 200)
    assert.equal(r.body.city, 'Taipei')
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal((await PlaceLookup.findOne({ key: 'nowhere tower|' })).place, null) // the miss above was saved too
})

test('when the map services fail, the place is not asked about again for a while', async () => {
  const calls = []
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, opts)
    calls.push(String(url))
    throw new Error('connect ECONNREFUSED')
  }
  try {
    assert.equal((await locate('Polaris Garden')).status, 502)
    const asked = calls.length
    assert.equal((await locate('Polaris Garden')).status, 502)
    assert.equal(calls.length, asked)
  } finally {
    globalThis.fetch = realFetch
  }
})
