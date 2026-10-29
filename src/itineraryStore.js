// Shared itinerary state, same idea as auth.js and preferences.js.
// FlightDelayWidget (Day 1, demo only) and ItineraryView both use this.
import { reactive } from 'vue'
import axios from 'axios'

// Day 1 (Mon 12 Oct) of the Seoul demo: arrival day. Hours are decimals: 13.5 = 1:30 PM.
// latestStart = last time the stop can still start (e.g. tour check-in closes).
export function makeDay1() {
  return [
    { id: 'd1-flight', type: 'flight', name: 'Flight KE621 arrives (ICN)', start: 13, duration: 0, buffer: 0.5 },
    { id: 'd1-transfer', type: 'transfer', name: 'Airport transfer', start: 13.5, duration: 0.5 },
    { id: 'd1-hotel', type: 'hotel', name: 'Hotel check-in', start: 14, duration: 0.5 },
    { id: 'd1-tour', type: 'tour', name: 'Gyeongbokgung Palace Tour', start: 15, duration: 2, latestStart: 15.5, latestNote: 'tour check-in closes at 3:30 PM' }
  ]
}

export function newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// Turn a saved stop into a live one (adds the fields the screen needs)
export function runtimeStop(s) {
  return {
    id: s.id, name: s.name, date: s.date, hour: s.hour,
    duration: s.duration ?? null,
    address: s.address || null,
    outdoor: !!s.outdoor,
    locked: !!s.locked,
    forecast: null, bestTime: null, loading: false, error: '', highlight: false, dataFrom: '',
    transitToNext: null, transitSecs: 0, replacedFrom: null
  }
}

export const trip = reactive({
  day1: makeDay1(),
  stops: [],     // every stop of the open trip, all days (each has a date)
  wishlist: []   // [{ id, name, address, outdoor: false }]
})

export function resetDay1() {
  trip.day1 = makeDay1()
}

// The Seoul demo trip (Day 2 = Tue 13 Oct 2026)
export function loadDemo() {
  const d = '2026-10-13'
  trip.stops = [
    runtimeStop({ id: 'd2-breakfast', date: d, hour: 10, duration: 1, name: 'Korean Street Food Breakfast', address: null, outdoor: false }),
    runtimeStop({ id: 'd2-palace', date: d, hour: 12, duration: null, name: 'Gyeongbokgung Palace', address: '161 Sajik-ro, Jongno-gu, Seoul, South Korea', outdoor: true }),
    runtimeStop({ id: 'd2-namsan', date: d, hour: 14, duration: null, name: 'Namsan Park (Outdoor)', address: '231 Samil-daero, Jung-gu, Seoul, South Korea', outdoor: true }),
    runtimeStop({ id: 'd2-dinner', date: d, hour: 18, duration: 1.5, name: 'Dinner Reservation (Myeongdong Kyoja)', address: null, outdoor: false, locked: true }),
    runtimeStop({ id: 'd2-itaewon', date: d, hour: 20, duration: null, name: 'Itaewon Street', address: 'Itaewon-ro, Yongsan-gu, Seoul, South Korea', outdoor: true })
  ]
  trip.wishlist = [
    { id: 'w-starfield', name: 'Starfield Library (Indoor Mall)', address: '513 Yeongdong-daero, Gangnam-gu, Seoul', outdoor: false, type: 'attraction', votes: ['Sarah', 'Amy'] },
    { id: 'w-museum', name: 'National Museum of Korea', address: '137 Seobinggo-ro, Yongsan-gu, Seoul', outdoor: false, type: 'museum', votes: ['John'] },
    { id: 'w-lotte', name: 'Lotte World Indoor Adventure', address: '240 Olympic-ro, Songpa-gu, Seoul', outdoor: false, type: 'theme_park', votes: ['Sarah', 'John', 'Amy'] }
  ]
}

// The stops as last loaded from (or saved to) the server. Sent with each save as "base",
// so the server can keep someone else's changes to the days instead of overwriting them.
let base = null
export function savedBase() {
  return base
}
export function markSaved(stops) {
  base = { stops: stops || savedShape().stops }
}

// A saved trip from the server (local: true = an Undo snapshot, not what the server has).
// While a wishlist change of ours is still on its way, the wishlist on screen is kept (see wishlistBusy).
export function loadFromServer(saved, { local = false, keepWishlist = false } = {}) {
  trip.version = saved.version || 0 // sent back when saving, so we never overwrite someone else's changes
  trip.stops = (saved.stops || []).map(runtimeStop)
  if (!keepWishlist) trip.wishlist = (saved.wishlist || []).map((w) => ({
    id: w.id, name: w.name, address: w.address || null, outdoor: !!w.outdoor,
    type: w.type || null, city: w.city || null, votes: Array.isArray(w.votes) ? w.votes : [],
    duration: w.duration || null, bookedVia: w.bookedVia || null, link: w.link || null
  }))
  if (!local) markSaved()
}

// Only the fields worth saving (no crowd data, loading flags, etc.)
export function savedShape() {
  return {
    stops: trip.stops.map((s) => ({ id: s.id, name: s.name, address: s.address, date: s.date, hour: s.hour, duration: s.duration, outdoor: s.outdoor, locked: s.locked })),
    wishlist: trip.wishlist.map((w) => ({ id: w.id, name: w.name, address: w.address, outdoor: !!w.outdoor, type: w.type || null, city: w.city || null, votes: w.votes || [], duration: w.duration || null, bookedVia: w.bookedVia || null, link: w.link || null }))
  }
}
// Save the open trip's stops (for pages that don't show the itinerary, e.g. trip setup)
export async function saveTrip(tripId) {
  if (!tripId || tripId === 'seoul') return // the demo trip isn't saved
  const since = wishChangeCount()
  try {
    const stops = savedShape().stops
    const res = await axios.put('/api/trips/' + tripId + '/itinerary', { stops, version: trip.version, base })
    if (res.data.merged) loadFromServer(res.data.trip, { keepWishlist: wishlistBusy(since) }) // someone else saved too: show both changes
    else markSaved(stops)
    trip.version = res.data.version
  } catch (err) {
    // 409: someone else saved first. Show their version instead of overwriting it.
    if (err.response && err.response.status === 409) loadFromServer(err.response.data.trip, { keepWishlist: wishlistBusy(since) })
    throw err
  }
}

// ---------- wishlist: saved one place at a time ----------
// Each add, edit or remove is its own request that changes just that place on the server,
// so two people saving places at the same moment never overwrite each other.
// The change shows at once; if the server says no, it is undone and the error is passed on.
let wishChanges = 0 // wishlist changes made on this page so far
let wishPending = 0 // of those, still on their way to the server
export function wishChangeCount() {
  return wishChanges
}
// True while a change is on its way, or one was made since `since` (= wishChangeCount() earlier):
// a trip loaded before then may not have it yet, so its wishlist must not replace ours.
export function wishlistBusy(since) {
  return wishPending > 0 || wishChanges !== since
}
async function wishRequest(tripId, send, undo) {
  wishChanges++
  if (!tripId || tripId === 'seoul') return // the demo trip isn't saved
  wishPending++
  try {
    await send('/api/trips/' + tripId + '/wishlist')
  } catch (err) {
    undo()
    throw err
  } finally {
    wishPending--
  }
}
export function addWish(tripId, item) {
  trip.wishlist.push(item)
  return wishRequest(tripId, (url) => axios.post(url, item), () => {
    trip.wishlist = trip.wishlist.filter((w) => w.id !== item.id)
  })
}
export function editWish(tripId, id, changes) {
  const w = trip.wishlist.find((x) => x.id === id)
  if (!w) return Promise.resolve()
  const before = {}
  for (const k in changes) before[k] = w[k]
  Object.assign(w, changes)
  return wishRequest(tripId, (url) => axios.patch(url + '/' + id, changes), () => Object.assign(w, before))
}
export function removeWish(tripId, id) {
  const i = trip.wishlist.findIndex((x) => x.id === id)
  if (i < 0) return Promise.resolve()
  const [w] = trip.wishlist.splice(i, 1)
  return wishRequest(tripId, (url) => axios.delete(url + '/' + id), () => {
    if (!trip.wishlist.some((x) => x.id === id)) trip.wishlist.splice(Math.min(i, trip.wishlist.length), 0, w)
  })
}
