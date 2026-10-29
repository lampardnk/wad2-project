import CacheEntry from './models/CacheEntry.js'

// Everything about calling outside services (maps, Wikipedia, weather, Google...) in one place,
// so the app stays inside each service's limits and doesn't get rate-limited:
//
// ask(service, url, options)   use it like fetch(): the same options, the same Response back
//  - calls to a service are spaced `gap` ms apart and at most `max` run at once (see SERVICES)
//  - when a service says it's busy (429, 502, 503, 504), times out or refuses us, it rests:
//    nobody asks it again until Retry-After (or 1 min, doubling each time, up to 10 min), and
//    ask() fails at once, so the caller's backup is used without waiting
//  - someone typing (urgent: true) goes ahead of background lookups
//  - timeout: ms to wait for an answer (default 10 s)
//
// remembered(key, keepFor, ask)   asks each question once (memory + MongoDB, see below)
// shared(key, work)               two requests for the same thing at the same moment share one answer
// askOverpass(query, waitSeconds) OpenStreetMap's Overpass, one public server after another
const UA = 'ChuiseYourTrip/1.0 (SMU IS216 student project)'
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE

const SERVICES = {
  nominatim: { gap: 1100, max: 1 }, // its usage policy: 1 request a second
  'overpass-de': { max: 2 }, // Overpass allows 2 queries at once per IP
  'overpass-coffee': { max: 2 },
  'overpass-kumi': { max: 2 },
  wikimedia: { max: 4 } // Wikipedia, Wikidata, Commons
}
const DEFAULT = { gap: 0, max: 4 }
const BUSY = [429, 502, 503, 504]
const FIRST_REST = MINUTE
const LONGEST_REST = 10 * MINUTE

const state = new Map() // service -> { active, last, urgent: [], later: [], restUntil, rests, timer }

function stateOf(service) {
  if (!state.has(service)) state.set(service, { active: 0, last: 0, urgent: [], later: [], restUntil: 0, rests: 0, timer: null })
  return state.get(service)
}
function policyOf(service) {
  return { ...DEFAULT, ...SERVICES[service] }
}

export function isResting(service) {
  return Date.now() < stateOf(service).restUntil
}

// The service is busy: leave it alone for a while (longer each time it happens again)
export function rest(service, retryAfter) {
  const s = stateOf(service)
  const seconds = Number(retryAfter)
  const ms = seconds > 0 ? seconds * SECOND : Math.min(LONGEST_REST, FIRST_REST * 2 ** s.rests)
  s.rests++
  s.restUntil = Math.max(s.restUntil, Date.now() + ms)
  console.warn(service + ' is busy: not asking it for ' + Math.round(ms / SECOND) + ' s')
}

function busyError(service) {
  const err = new Error(service + ' is busy, try again later')
  err.busy = true
  return err
}

// Wait for a free slot: under `max` at once, `gap` after the last call ended
function take(service, urgent, signal) {
  return new Promise((resolve, reject) => {
    stateOf(service)[urgent ? 'urgent' : 'later'].push({ resolve, reject, signal, urgent })
    pump(service)
  })
}
function pump(service) {
  const s = stateOf(service)
  const p = policyOf(service)
  while (s.active < p.max) {
    const job = s.urgent.shift() || s.later.shift() // picked now, so someone typing meanwhile goes first
    if (!job) return
    if (job.signal && job.signal.aborted) {
      job.reject(new Error(service + ' not needed any more'))
      continue
    }
    if (isResting(service)) {
      job.reject(busyError(service))
      continue
    }
    const wait = s.last + p.gap - Date.now()
    if (wait > 0) {
      s[job.urgent ? 'urgent' : 'later'].unshift(job)
      if (!s.timer) s.timer = setTimeout(() => { s.timer = null; pump(service) }, wait)
      return
    }
    s.active++
    job.resolve()
  }
}
function release(service) {
  const s = stateOf(service)
  s.active--
  s.last = Date.now()
  pump(service)
}

export async function ask(service, url, { timeout = 10 * SECOND, urgent = false, signal, headers, ...init } = {}) {
  if (isResting(service)) throw busyError(service)
  await take(service, urgent, signal)
  const timer = AbortSignal.timeout(timeout)
  try {
    const response = await fetch(url, {
      ...init,
      headers: { 'User-Agent': UA, ...headers },
      signal: signal ? AbortSignal.any([signal, timer]) : timer
    })
    if (BUSY.includes(response.status)) {
      rest(service, response.headers.get('retry-after'))
      throw busyError(service)
    }
    stateOf(service).rests = 0 // answered normally: the next rest starts short again
    return response
  } catch (err) {
    // Timed out or refused (not cancelled by the caller): it's overloaded or blocking us
    if (!err.busy && !(signal && signal.aborted)) rest(service)
    throw err
  } finally {
    release(service)
  }
}

// ---------- OpenStreetMap's Overpass ----------
// Public servers, tried one after another (a busy one answers 429/502 at once, so moving on is quick).
// Asking all of them at once would use up our 2-at-once allowance everywhere.
const OVERPASS = [
  ['overpass-de', 'https://overpass-api.de/api/interpreter'],
  ['overpass-coffee', 'https://overpass.private.coffee/api/interpreter'],
  ['overpass-kumi', 'https://overpass.kumi.systems/api/interpreter']
]
export async function askOverpass(query, waitSeconds) {
  const deadline = Date.now() + waitSeconds * SECOND
  const reasons = []
  for (const [service, url] of OVERPASS) {
    const left = deadline - Date.now()
    if (left < 2 * SECOND) break
    if (isResting(service)) {
      reasons.push(service + ' resting')
      continue
    }
    try {
      const response = await ask(service, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        timeout: left
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const text = await response.text()
      let data
      try {
        data = JSON.parse(text)
      } catch {
        rest(service) // an HTML "too busy" page
        throw new Error('not JSON')
      }
      // When busy, Overpass can answer "OK" with no places and a remark like "Query timed out"
      if (data.remark && !(data.elements || []).length) {
        rest(service)
        throw new Error(data.remark)
      }
      return data
    } catch (err) {
      reasons.push(service + ': ' + err.message)
    }
  }
  throw new Error('All Overpass servers failed: ' + reasons.join('; '))
}

// ---------- asking each question once ----------
// Answers from outside services, kept in memory and in MongoDB, so each question is asked once:
// a server restart starts warm, and paid or rate-limited services aren't asked again and again.
//
// remembered(key, keepFor, ask)
//  - a saved answer younger than keepFor (ms, or a function of the answer) is used as it is
//  - otherwise ask() runs, and its answer is saved (undefined = don't save)
//  - two requests for the same key at the same moment share one ask()
//  - if ask() fails, an older saved answer is used instead; with none, the error is passed on
const KEEP_OLD = 30 * DAY // how long an expired answer is kept as a fallback
const LIMIT = 1000
const memory = new Map() // key -> { value, until }
const inFlight = new Map() // key -> promise

export function shared(key, work) {
  if (!inFlight.has(key)) inFlight.set(key, work().finally(() => inFlight.delete(key)))
  return inFlight.get(key)
}

function keep(key, value, until) {
  if (memory.size >= LIMIT) memory.delete(memory.keys().next().value)
  memory.set(key, { value, until })
}

export function remembered(key, keepFor, ask) {
  const m = memory.get(key)
  if (m && Date.now() < m.until) return Promise.resolve(m.value)
  return shared('remembered|' + key, () => lookUp(key, keepFor, ask))
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
