// Integration: two people ticking packing items at the same time, through the API and MongoDB
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { express, request, startDb, stopDb, makeTrip } from './helpers.js'

const { default: tripRoutes } = await import('../../server/routes/trips.js')
const app = express()
app.use(express.json())
app.use('/api/trips', tripRoutes)

before(startDb)
after(stopDb)

test('Amy and Ben tick different items from the same list: both stay ticked', async () => {
  const t = await makeTrip()
  const empty = { checked: {}, qty: {}, removed: [], custom: [] }
  const save = (who, item) => request(app).put('/api/trips/' + t.id + '/packing').set('Authorization', who)
    .send({ activities: [], weather: [], extras: [], base: empty, packing: { ...empty, checked: { [item]: true } } })

  await Promise.all([save(t.amy, 'passport'), save(t.ben, 'power-bank')])

  const r = await request(app).get('/api/trips/' + t.id + '/packing').set('Authorization', t.amy)
  assert.deepEqual(r.body.packing.checked, { passport: true, 'power-bank': true })
})
