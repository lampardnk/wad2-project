import CacheEntry from './models/CacheEntry.js'

// Answers from outside services, kept in memory and in MongoDB, so each question is asked once:
// a server restart starts warm, and paid or rate-limited services aren't asked again and again.
//
// remembered(key, keepFor, ask)
//  - a saved answer younger than keepFor (ms, or a function of the answer) is used as it is
//  - otherwise ask() runs, and its answer is saved (undefined = don't save)
//  - two requests for the same key at the same moment share one ask()
//  - if ask() fails, an older saved answer is used instead; with none, the error is passed on
const DAY = 24 * 60 * 60 * 1000
const KEEP_OLD = 30 * DAY // how long an expired answer is kept as a fallback
const LIMIT = 1000
const memory = new Map() // key -> { value, until }
const inFlight = new Map() // key -> promise

function keep(key, value, until) {
  if (memory.size >= LIMIT) memory.delete(memory.keys().next().value)
  memory.set(key, { value, until })
}

export function remembered(key, keepFor, ask) {
  const m = memory.get(key)
  if (m && Date.now() < m.until) return Promise.resolve(m.value)
  if (!inFlight.has(key)) inFlight.set(key, lookUp(key, keepFor, ask).finally(() => inFlight.delete(key)))
  return inFlight.get(key)
}

async function lookUp(key, keepFor, ask) {
  const saved = await CacheEntry.findOne({ key }).lean()
  if (saved && saved.expiresAt > new Date()) {
    keep(key, saved.value, saved.expiresAt.getTime())
    return saved.value
  }
  let value
  try {
    value = await ask()
  } catch (err) {
    if (saved) return saved.value // older is better than nothing
    throw err
  }
  if (value === undefined) return value
  const until = Date.now() + (typeof keepFor === 'function' ? keepFor(value) : keepFor)
  keep(key, value, until)
  await CacheEntry.updateOne({ key }, { value, expiresAt: new Date(until), removeAt: new Date(until + KEEP_OLD) }, { upsert: true })
  return value
}
