import express from 'express'
import { requireAuth } from './auth.js'
import { ask, remembered } from '../outside.js'

const router = express.Router()

// The free plan only allows about 100 requests a month, so remember answers for 15 minutes
const CACHE_MINUTES = 15

// GET /api/flights?flight=KE621
router.get('/', requireAuth, async (req, res) => {
  const flight = String(req.query.flight || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{2,8}$/.test(flight)) {
    return res.status(400).json({ message: 'Please give a flight number like KE621.' })
  }
  if (!process.env.AVIATIONSTACK_API_KEY) {
    return res.status(503).json({ message: 'Flights are not set up yet (AVIATIONSTACK_API_KEY missing in server/.env).' })
  }

  // null = no live data for that flight (also remembered, to save the monthly allowance)
  let data
  try {
    data = await remembered('flight|' + flight, CACHE_MINUTES * 60 * 1000, () => lookUpFlight(flight))
  } catch (err) {
    return res.status(502).json({ message: 'Flight service error. Try again later.' })
  }
  if (!data) return res.status(404).json({ message: 'No live data for that flight right now.' })
  res.json(data)
})

async function lookUpFlight(flight) {
  const params = new URLSearchParams({ access_key: process.env.AVIATIONSTACK_API_KEY, flight_iata: flight })
  const response = await ask('aviationstack', 'http://api.aviationstack.com/v1/flights?' + params)
  const body = await response.json()

  if (body.error) {
    console.error('Aviationstack error:', body.error.message)
    throw new Error('Aviationstack: ' + body.error.message)
  }
  const f = body.data && body.data[0]
  if (!f) return null

  // Delay = how much later than scheduled the flight arrives (or arrived).
  // Comparing the times is more reliable than the API's "delay" field.
  const arr = f.arrival || {}
  const arrivedAt = arr.actual || arr.estimated
  let delayMinutes
  if (arr.scheduled && arrivedAt) {
    delayMinutes = Math.round((new Date(arrivedAt) - new Date(arr.scheduled)) / 60000)
  } else {
    delayMinutes = arr.delay || 0
  }

  return {
    flight,
    status: f.flight_status,
    delayMinutes: Math.max(0, delayMinutes), // early arrivals count as 0, not negative
    originalArrival: arr.scheduled,
    newArrival: arrivedAt
  }
}

export default router