// The per-minute limit counts signed-in people separately, even on one shared IP (hotel / campus Wi-Fi)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import jwt from 'jsonwebtoken'
import { rateLimit } from '../rateLimit.js'

process.env.JWT_SECRET = 'test-secret'

function hit(limit, token) {
  let status = 200
  const req = { ip: '10.0.0.1', headers: token ? { authorization: 'Bearer ' + token } : {} }
  const res = { set() {}, status(code) { status = code; return { json() {} } } }
  limit(req, res, () => {})
  return status
}

test('two people on one IP each get their own limit', () => {
  const limit = rateLimit({ max: 2 })
  const amy = jwt.sign({ id: 'amy' }, process.env.JWT_SECRET)
  const ben = jwt.sign({ id: 'ben' }, process.env.JWT_SECRET)
  assert.deepEqual([hit(limit, amy), hit(limit, amy), hit(limit, amy)], [200, 200, 429])
  assert.equal(hit(limit, ben), 200)
})

test('without a login the IP address is counted', () => {
  const limit = rateLimit({ max: 1 })
  assert.deepEqual([hit(limit), hit(limit)], [200, 429])
})
