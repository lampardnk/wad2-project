import express from 'express'
import { requireAuth } from './auth.js'
import { nominatim, photonOrBackup } from './places.js'
import { askOverpass, remembered } from '../outside.js'

// Safety tab helpers. These run on our server (not in the browser) so that:
//  - busy OpenStreetMap servers are retried and results are remembered (no more 504s in the browser)
//  - the same answer is reused by everyone on the trip
const router = express.Router()
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// Photon (OpenStreetMap search). lang 'default' gives local names, e.g. Japanese.
async function photon(params) {
  // Photon is slow or refusing us: Nominatim has the same OpenStreetMap places (answer reshaped like Photon's)
  return photonOrBackup(params, async (signal) => {
    const q = { q: params.q, limit: params.limit || '5', addressdetails: '1' }
    if (params.lang !== 'default') q['accept-language'] = 'en'
    if (params.lat) {
      const lat = Number(params.lat)
      const lon = Number(params.lon)
      q.viewbox = [lon - 0.3, lat + 0.3, lon + 0.3, lat - 0.3].join(',')
      if (params.osm_tag) q.bounded = '1' // "hospital" etc.: only ones around here
    }
    let list = await nominatim(q, signal)
    // Nominatim needs every word to match: "Sun Moon Lake, Taipei" finds nothing (it isn't in Taipei)
    if (!list.length && q.q.includes(',')) list = await nominatim({ ...q, q: q.q.split(',')[0] }, signal)
    return {
      features: list.map((r) => {
        const a = r.address || {}
        return {
          geometry: { coordinates: [Number(r.lon), Number(r.lat)] },
          properties: {
            name: r.name || (r.display_name || '').split(',')[0], osm_id: r.osm_id, osm_value: r.addresstype,
            housenumber: a.house_number, street: a.road, district: a.suburb || a.neighbourhood,
            city: a.city || a.town || a.village, postcode: a.postcode, country: a.country, countrycode: a.country_code
          }
        }
      })
    }
  })
}

function addressOf(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ')
  return [street, p.district || p.locality, p.city, p.postcode].filter(Boolean).join(', ')
}

// GET /api/safety/locate?place=Kyoto, Japan[&near=Chengdu, China] -> { lat, lon, city, countryCode, countryName }
// "near" = the trip city the place belongs to. Many names exist in several places (there are
// Mao Zedong statues all over China), so we search around that city and keep a match within 80 km.
async function locateOne(place) {
  const data = await photon({ q: place, limit: '1', lang: 'en' })
  return data.features && data.features[0]
}
function toResult(f, place) {
  const p = f.properties || {}
  return {
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    city: p.city || p.name || place,
    countryCode: (p.countrycode || '').toUpperCase(),
    countryName: p.country || ''
  }
}
function kmBetween(a, b) {
  const r = Math.PI / 180
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r)
  const y = (b.lat - a.lat) * r
  return Math.sqrt(x * x + y * y) * 6371
}

// A place's coordinates (null = not found). Found places are remembered for 30 days and "not found"
// for a day, so a trip page that asks for every stop again doesn't send the same questions over and over.
// Two people asking for the same place at once share one lookup (see remembered in outside.js).
function locate(place, near) {
  const key = 'locate|' + (place + '|' + near).toLowerCase()
  return remembered(key, (found) => (found ? 30 * DAY : DAY), () => findPlace(place, near))
}

// Ask the map services where a place is (see locate for the caching)
async function findPlace(place, near) {
  let found = null
  if (near) {
    // Where the city is (cached like any other lookup)
    const city = await locate(near, '')
    if (city) {
      // Results ranked around the city; keep the closest one that's actually nearby
      const data = await photon({ q: place, limit: '8', lang: 'en', lat: String(city.lat), lon: String(city.lon) })
      let best = null
      let bestKm = Infinity
      for (const f of data.features || []) {
        const r = toResult(f, place)
        const km = kmBetween(city, r)
        if (km < bestKm) {
          best = r
          bestKm = km
        }
      }
      if (best && bestKm <= 80) found = best
      // Nothing that close: try the name together with the city
      if (!found) {
        const f = await locateOne(place + ', ' + near)
        if (f) {
          const r = toResult(f, place)
          if (kmBetween(city, r) <= 80) found = r
        }
      }
      if (!found && best) found = best // closest we have
    }
  }
  if (!found) {
    const f = await locateOne(place)
    if (f) found = toResult(f, place)
  }
  return found
}

router.get('/locate', requireAuth, async (req, res) => {
  const place = String(req.query.place || '').trim().slice(0, 200)
  const near = String(req.query.near || '').trim().slice(0, 120)
  if (!place) return res.status(400).json({ message: 'Which place?' })
  try {
    const found = await locate(place, near)
    if (!found) return res.status(404).json({ message: 'Could not find that place.' })
    res.json(found)
  } catch (err) {
    res.status(502).json({ message: 'Place lookup is unavailable right now.' })
  }
})

// GET /api/safety/stay-search?q=Hotel Gracery&near=Tokyo, Japan
// -> [{ name, address, nameLocal, addressLocal, lat, lon }] English + local script (for taxi drivers)
router.get('/stay-search', requireAuth, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120)
  const near = String(req.query.near || '').trim().slice(0, 80)
  if (q.length < 3) return res.json([])
  try {
    const params = { q: near ? q + ', ' + near : q, limit: '5' }
    const [en, local] = await Promise.all([photon({ ...params, lang: 'en' }), photon({ ...params, lang: 'default' })])
    const out = []
    for (const f of en.features || []) {
      const p = f.properties || {}
      if (!p.name) continue
      // The same place in the local-language answer (matched by its OpenStreetMap id)
      const twin = (local.features || []).find((g) => g.properties && g.properties.osm_id === p.osm_id) || f
      const lp = twin.properties || {}
      out.push({
        name: p.name,
        address: addressOf(p),
        nameLocal: lp.name || '',
        addressLocal: addressOf(lp),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0]
      })
    }
    res.json(out)
  } catch (err) {
    res.status(502).json({ message: 'Place search is unavailable right now.' })
  }
})

// ---------- Help nearby ----------
const LABELS = { hospital: 'Hospital', clinic: 'Clinic', police: 'Police', fire_station: 'Fire station', shelter: 'Evacuation point', embassy: 'Embassy' }

// Overpass elements -> our places
function toPlaces(elements) {
  const places = []
  for (const el of elements || []) {
    const t = el.tags || {}
    const pLat = el.lat !== undefined ? el.lat : el.center && el.center.lat
    const pLon = el.lon !== undefined ? el.lon : el.center && el.center.lon
    if (pLat === undefined) continue
    let kind = t.amenity
    if (t.emergency === 'assembly_point' || t.amenity === 'shelter') kind = 'shelter'
    if (t.diplomatic === 'embassy' || t.amenity === 'embassy') kind = 'embassy'
    places.push({
      id: el.type + el.id,
      kind,
      name: t['name:en'] || t.name || LABELS[kind] || 'Unnamed',
      nameLocal: t['name:en'] && t.name && t.name !== t['name:en'] ? t.name : '',
      lat: pLat,
      lon: pLon,
      phone: t.phone || t['contact:phone'] || null,
      openingHours: t.opening_hours || null, // e.g. "24/7" or "Mo-Fr 09:00-18:00; Sa 09:00-12:00"
      emergency: t.emergency === 'yes' // hospitals with an A&E
    })
  }
  return places
}

function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r)
  const y = (bLat - aLat) * r
  return Math.sqrt(x * x + y * y) * 6371
}

// Backup when Overpass is down: Photon (fast OpenStreetMap search), one search per kind, kept within 8 km
async function photonNearby(lat, lon) {
  const kinds = ['hospital', 'clinic', 'police', 'fire_station']
  const answers = await Promise.allSettled(kinds.map((kind) =>
    photon({ q: kind.replace('_', ' '), lat: String(lat), lon: String(lon), osm_tag: 'amenity:' + kind, limit: '10', lang: 'en' })
  ))
  const places = []
  for (let i = 0; i < kinds.length; i++) {
    if (answers[i].status !== 'fulfilled') continue
    for (const f of answers[i].value.features || []) {
      const p = f.properties || {}
      const pLat = f.geometry.coordinates[1]
      const pLon = f.geometry.coordinates[0]
      if (km(lat, lon, pLat, pLon) > 8) continue
      places.push({
        id: (p.osm_type || 'x') + p.osm_id,
        kind: kinds[i],
        name: p.name || LABELS[kinds[i]],
        nameLocal: '',
        lat: pLat,
        lon: pLon,
        phone: null,
        openingHours: null,
        emergency: false
      })
    }
  }
  if (!places.length && answers.every((a) => a.status === 'rejected')) throw new Error('Photon backup failed')
  return places
}

// GET /api/safety/nearby?lat=35.0&lon=135.7&home=SG
// -> hospitals, clinics, police, fire stations, evacuation points / shelters within 3 km,
//    plus your country's embassy within 40 km. Each: { id, kind, name, lat, lon, phone, openingHours, emergency }
// Fast path: every Overpass server is asked at once; the embassy search runs alongside;
// if Overpass is down, Photon fills in hospitals/clinics/police/fire stations within a few seconds.
const round2 = (n) => Math.round(Number(n) * 100) / 100 // about 1 km: walking around reuses the same answer
router.get('/nearby', requireAuth, async (req, res) => {
  const lat = round2(req.query.lat)
  const lon = round2(req.query.lon)
  const home = /^[A-Z]{2}$/.test(String(req.query.home || '')) ? req.query.home : 'SG'
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ message: 'Invalid location.' })
  }
  // A full answer is kept for a day; a partial one (backup source / no embassy) only for 10 minutes.
  // If every source fails, an older answer is used (remembered in outside.js).
  try {
    res.json(await remembered('safety-nearby|' + lat + ',' + lon + ',' + home, (d) => (d.partial ? 10 * MINUTE : DAY), () => findNearby(lat, lon, home)))
  } catch (err) {
    console.error('Safety nearby failed:', err.message)
    res.status(502).json({ message: 'Nearby services are unavailable right now.' })
  }
})

async function findNearby(lat, lon, home) {
  const at = lat + ',' + lon
  const coreQuery = '[out:json][timeout:10];(' +
    'nwr["amenity"~"^(hospital|clinic|police|fire_station)$"](around:3000,' + at + ');' +
    'nwr["emergency"="assembly_point"](around:3000,' + at + ');' +
    'nwr["amenity"="shelter"]["shelter_type"!~"public_transport|picnic_shelter|lean_to|field_shelter"](around:3000,' + at + ');' +
    ');out tags center 200;'
  const embassyQuery = '[out:json][timeout:12];(' +
    'nwr["diplomatic"="embassy"]["country"="' + home + '"](around:40000,' + at + ');' +
    'nwr["amenity"="embassy"]["country"="' + home + '"](around:40000,' + at + ');' +
    ');out tags center 5;'

  // All at the same time
  const [core, embassy] = await Promise.allSettled([askOverpass(coreQuery, 12), askOverpass(embassyQuery, 14)])

  let places = []
  let complete = true
  if (core.status === 'fulfilled') {
    places = toPlaces(core.value.elements)
  } else {
    console.error('Safety nearby (Overpass) failed:', core.reason.message)
    complete = false
    places = await photonNearby(lat, lon)
  }
  if (embassy.status === 'fulfilled') places = places.concat(toPlaces(embassy.value.elements))
  else complete = false

  return { lat, lon, places, partial: !complete }
}

export default router
