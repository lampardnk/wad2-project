import express from 'express'
import { requireAuth } from './auth.js'
import { ask, remembered } from '../outside.js'

const router = express.Router()

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// GET /api/weather?lat=37.56&lon=126.97   OR   /api/weather?q=Kyoto, Japan
// Answers are saved (see cache.js): a place's coordinates for a year, a forecast for 15 minutes.
router.get('/', requireAuth, async (req, res) => {
  const key = process.env.OPENWEATHER_API_KEY
  if (!key) {
    return res.status(503).json({ message: 'Weather is not set up yet (OPENWEATHER_API_KEY missing in server/.env).' })
  }

  let lat = Number(req.query.lat)
  let lon = Number(req.query.lon)

  try {
    // A place name: look up its coordinates (null = not found, asked again after a day)
    if (req.query.q) {
      const q = String(req.query.q).slice(0, 100)
      const place = await remembered('weather-place|' + q.toLowerCase(), (p) => (p ? 365 * DAY : DAY), async () => {
        const geoParams = new URLSearchParams({ q, limit: '1', appid: key })
        const geoRes = await ask('openweather', 'https://api.openweathermap.org/geo/1.0/direct?' + geoParams)
        if (!geoRes.ok) {
          console.error('OpenWeather geocode failed:', geoRes.status, await geoRes.text())
          throw new Error('OpenWeather geocode ' + geoRes.status)
        }
        const geo = await geoRes.json()
        return geo.length ? { lat: geo[0].lat, lon: geo[0].lon } : null
      })
      if (!place) return res.status(404).json({ message: 'Could not find that destination for weather.' })
      lat = place.lat
      lon = place.lon
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ message: 'Please give lat and lon, or a place name (q).' })
    }

    // Same area (to about 1 km) asked for again within 15 minutes: the saved forecast (free)
    const cacheKey = lat.toFixed(2) + ',' + lon.toFixed(2)
    const result = await remembered('weather|' + cacheKey, 15 * MINUTE, async () => {
      console.log('Calling OpenWeather for', cacheKey)
      const params = new URLSearchParams({ lat, lon, units: 'metric', appid: key })
      const response = await ask('openweather', 'https://api.openweathermap.org/data/2.5/forecast?' + params)
      if (!response.ok) {
        console.error('OpenWeather forecast failed:', response.status, await response.text())
        throw new Error('OpenWeather forecast ' + response.status)
      }
      const data = await response.json()
      return { city: { timezone: data.city.timezone }, list: data.list }
    })
    res.json(result)
  } catch (err) {
    res.status(502).json({ message: 'Weather service error. Try again later.' })
  }
})

export default router