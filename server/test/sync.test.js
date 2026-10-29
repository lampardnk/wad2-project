// Two people using the same trip at once (the prof's "changes don't sync" feedback)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import request from 'supertest'
import { startDb, stopDb, makeApp, makeTrip, stop, place } from './helpers.js'

const app = makeApp()
before(startDb)
after(stopDb)

const put = (id, token, path, body) => request(app).put('/api/trips/' + id + path).set('Authorization', token).send(body)
const get = (id, token, path = '') => request(app).get('/api/trips/' + id + path).set('Authorization', token)

const post = (id, token, path, body) => request(app).post('/api/trips/' + id + path).set('Authorization', token).send(body)
const del = (id, token, path) => request(app).delete('/api/trips/' + id + path).set('Authorization', token)
const patch = (id, token, path, body) => request(app).patch('/api/trips/' + id + path).set('Authorization', token).send(body)

test('wishlist: Amy and Ben save places at the same moment, every place is kept', async () => {
  const t = await makeTrip()
  const adds = []
  for (let i = 0; i < 5; i++) {
    adds.push(post(t.id, t.amy, '/wishlist', place('a' + i)))
    adds.push(post(t.id, t.ben, '/wishlist', place('b' + i)))
  }
  for (const r of await Promise.all(adds)) assert.equal(r.status, 200)
  const trip = (await get(t.id, t.amy)).body
  assert.equal(trip.wishlist.length, 10)
})

test('wishlist: Amy removes a place while Ben adds one, both changes stay', async () => {
  const t = await makeTrip({ wishlist: [place('w1'), place('w2')] })
  const [r1, r2] = await Promise.all([del(t.id, t.amy, '/wishlist/w1'), post(t.id, t.ben, '/wishlist', place('w3'))])
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  assert.deepEqual((await get(t.id, t.amy)).body.wishlist.map((w) => w.id).sort(), ['w2', 'w3'])
})

test('wishlist: the same add sent twice is saved once', async () => {
  const t = await makeTrip()
  await Promise.all([post(t.id, t.amy, '/wishlist', place('w1')), post(t.id, t.amy, '/wishlist', place('w1'))])
  assert.equal((await get(t.id, t.amy)).body.wishlist.length, 1)
})

test('wishlist: editing a place changes only that place, and keeps its votes', async () => {
  const t = await makeTrip({ wishlist: [place('w1', { name: 'Shrine', votes: ['Ben'] }), place('w2', { name: 'Market' })] })
  const r = await patch(t.id, t.amy, '/wishlist/w1', { name: 'Meiji Shrine', address: 'Shibuya, Tokyo' })
  assert.equal(r.status, 200)
  const [w1, w2] = (await get(t.id, t.amy)).body.wishlist
  assert.equal(w1.name, 'Meiji Shrine')
  assert.equal(w1.address, 'Shibuya, Tokyo')
  assert.deepEqual(w1.votes, ['Ben'])
  assert.equal(w2.name, 'Market')
  assert.equal((await patch(t.id, t.amy, '/wishlist/gone', { name: 'X' })).status, 404)
})

test('itinerary: an older page saving the days cannot undo a place Ben just added', async () => {
  const t = await makeTrip()
  const s = stop('s1', '2026-12-01', 9)
  await put(t.id, t.amy, '/itinerary', { stops: [s], version: 0 })
  await post(t.id, t.ben, '/wishlist', place('w9'))
  // Amy's page still shows an empty wishlist, and sends it along with a stop move
  const r = await put(t.id, t.amy, '/itinerary', { stops: [{ ...s, hour: 14 }], wishlist: [], version: 1, base: { stops: [s], wishlist: [] } })
  assert.equal(r.status, 200)
  const trip = (await get(t.id, t.amy)).body
  assert.equal(trip.stops[0].hour, 14) // Amy's move
  assert.deepEqual(trip.wishlist.map((w) => w.id), ['w9']) // Ben's place
})

test('itinerary: both change the days at once, the second gets 409 with the latest trip', async () => {
  const t = await makeTrip()
  const s = stop('s1', '2026-12-01', 9)
  await put(t.id, t.amy, '/itinerary', { stops: [s], wishlist: [], version: 0 })
  const base = { stops: [s], wishlist: [] }
  const r1 = await put(t.id, t.amy, '/itinerary', { stops: [{ ...s, hour: 10 }], wishlist: [], version: 1, base })
  const r2 = await put(t.id, t.ben, '/itinerary', { stops: [{ ...s, hour: 16 }], wishlist: [], version: 1, base })
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 409)
  assert.equal(r2.body.trip.stops[0].hour, 10)
})

test('albums: Amy and Ben each add an album, both are kept', async () => {
  const t = await makeTrip()
  await put(t.id, t.amy, '/albums', { albums: [{ id: 'a1', name: 'Shrines', icon: '⛩' }], base: [] })
  const r = await put(t.id, t.ben, '/albums', { albums: [{ id: 'a2', name: 'Food', icon: '🍜' }], base: [] })
  assert.deepEqual(r.body.albums.map((a) => a.id), ['a1', 'a2'])
  assert.equal((await get(t.id, t.amy, '/albums')).body.albums.length, 2)
})

test('packing: Amy and Ben tick different items, both stay ticked', async () => {
  const t = await makeTrip()
  const empty = { checked: {}, qty: {}, removed: [], custom: [] }
  await put(t.id, t.amy, '/packing', { packing: { ...empty, checked: { passport: true } }, base: empty })
  await put(t.id, t.ben, '/packing', { packing: { ...empty, checked: { charger: true } }, base: empty })
  const res = await get(t.id, t.ben, '/packing')
  assert.deepEqual(res.body.packing.checked, { passport: true, charger: true })
})

test('packing: an item someone adds keeps who added it', async () => {
  const t = await makeTrip()
  const empty = { checked: {}, qty: {}, removed: [], custom: [] }
  const film = { id: 'mine-1', category: 'other', name: 'Film camera', qty: 1, by: 'Ben' }
  await put(t.id, t.ben, '/packing', { packing: { ...empty, custom: [film] }, base: empty })
  const res = await get(t.id, t.amy, '/packing')
  assert.equal(res.body.packing.custom[0].by, 'Ben')
})

test('the trip page notices any change with a tiny check', async () => {
  const t = await makeTrip()
  const first = (await get(t.id, t.amy, '/changed')).body.changedAt
  assert.ok(first)
  assert.equal((await get(t.id, t.ben, '/changed')).body.changedAt, first) // nothing changed
  await new Promise((resolve) => setTimeout(resolve, 5))
  await post(t.id, t.ben, '/wishlist', place('w1'))
  const after = (await get(t.id, t.amy, '/changed')).body.changedAt
  assert.notEqual(after, first)
  assert.equal((await get(t.id, t.amy)).body.changedAt, after) // the full trip says the same
})
