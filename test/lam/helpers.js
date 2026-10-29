// Shared setup for Lam's API tests: a throwaway MongoDB in memory and a trip with two people (Amy and Ben).
// The server's packages live in server/node_modules, so they are loaded from there.
import { createRequire } from 'node:module'

const require = createRequire(new URL('../../server/package.json', import.meta.url))
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const { MongoMemoryServer } = require('mongodb-memory-server')
export const express = require('express')
export const request = require('supertest')

process.env.JWT_SECRET = 'test-secret'

const { default: Trip } = await import('../../server/models/trip.js')
const { default: User } = await import('../../server/models/User.js')

let mongo
export async function startDb() {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  return mongo.getUri()
}
export async function stopDb() {
  await mongoose.disconnect()
  await mongo.stop()
}

export async function makeTrip() {
  const n = Math.random().toString(36).slice(2, 8)
  const amy = await User.create({ name: 'Amy', username: 'amy' + n, email: 'amy' + n + '@x.com', passwordHash: 'x' })
  const ben = await User.create({ name: 'Ben', username: 'ben' + n, email: 'ben' + n + '@x.com', passwordHash: 'x' })
  const trip = await Trip.create({
    owner: amy._id, name: 'Test trip', destination: 'Tokyo, Japan', destinations: ['Tokyo, Japan'],
    startDate: '2026-12-01', endDate: '2026-12-03', travellers: ['Amy', 'Ben'],
    members: [{ user: amy._id, name: 'Amy', role: 'owner' }, { user: ben._id, name: 'Ben', role: 'member' }]
  })
  const token = (u) => 'Bearer ' + jwt.sign({ id: u._id }, process.env.JWT_SECRET)
  return { id: String(trip._id), amy: token(amy), ben: token(ben) }
}
