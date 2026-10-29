import express from 'express'
import { requireAuth } from './auth.js'
import { remembered } from '../cache.js'

const router = express.Router()

const DAY = 24 * 60 * 60 * 1000
const MODES = { transit: 'TRANSIT', walking: 'WALK', driving: 'DRIVE', bicycling: 'BICYCLE' }

// GET /api/distance-matrix?origin=...&destination=...&mode=transit
// Uses Google's Routes API (computeRouteMatrix). Returns { durationText, durationValue }.
router.get('/', requireAuth, async (req, res) => {
  const origin = (req.query.origin || '').trim()
  const destination = (req.query.destination || '').trim()
  const travelMode = MODES[req.query.mode] || 'TRANSIT'
  if (!origin || !destination) return res.status(400).json({ message: 'Please give origin and destination.' })
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return res.status(503).json({ message: 'Maps is not set up yet (GOOGLE_MAPS_API_KEY missing in server/.env).' })
  }

  // Google charges per request: each leg is asked once a week (null = no route, kept for a day)
  const key = ['leg', travelMode, origin, destination].join('|').toLowerCase()
  let seconds
  try {
    seconds = await remembered(key, (found) => (found === null ? DAY : 7 * DAY), async () => {
      const response = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,status,condition'
        },
        body: JSON.stringify({
          origins: [{ waypoint: { address: origin } }],
          destinations: [{ waypoint: { address: destination } }],
          travelMode
        }),
        signal: AbortSignal.timeout(10000)
      })

      if (!response.ok) {
        console.error('Routes API error:', response.status, await response.text())
        throw new Error('Routes API ' + response.status)
      }

      const data = await response.json()
      const el = Array.isArray(data) ? data[0] : null
      if (!el || el.condition !== 'ROUTE_EXISTS' || !el.duration) return null
      return parseInt(el.duration, 10) // Google sends "1440s"
    })
  } catch (err) {
    return res.status(502).json({ message: 'Maps service error. Check the server terminal.' })
  }
  if (seconds === null) return res.status(404).json({ message: 'No route found between those places.' })

  const mins = Math.max(1, Math.round(seconds / 60))
  const durationText = mins >= 60 ? Math.floor(mins / 60) + ' hr ' + (mins % 60) + ' mins' : mins + ' mins'
  res.json({ durationText, durationValue: seconds })
})

export default router