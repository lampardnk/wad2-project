// Integration: a photo uploaded by one person is seen by the group, with reactions
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { express, request, startDb, stopDb, makeTrip } from './helpers.js'

const { default: photoRoutes } = await import('../../server/routes/photos.js')
const app = express()
app.use(express.json())
app.use('/api/trips/:tripId/photos', photoRoutes)

before(startDb)
after(stopDb)

test('Amy uploads a photo, Ben sees it and reacts, then Amy deletes it', async () => {
  const t = await makeTrip()
  const photos = '/api/trips/' + t.id + '/photos'

  const up = await request(app).post(photos + '?name=shibuya.jpg').set('Authorization', t.amy)
    .set('Content-Type', 'image/jpeg').send(Buffer.from('fake jpeg bytes'))
  assert.equal(up.status, 201)

  const seen = await request(app).get(photos).set('Authorization', t.ben)
  assert.equal(seen.body[0].uploadedBy, 'Amy')

  const react = await request(app).post(photos + '/' + up.body.id + '/react').set('Authorization', t.ben).send({ emoji: '❤️' })
  assert.deepEqual(react.body.reactions, { '❤️': ['Ben'] })

  await request(app).delete(photos + '/' + up.body.id).set('Authorization', t.amy).expect(200)
  assert.equal((await request(app).get(photos).set('Authorization', t.ben)).body.length, 0)
})
