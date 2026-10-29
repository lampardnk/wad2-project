import express from 'express'
import { requireAuth } from './auth.js'
import { ask, remembered } from '../outside.js'

const router = express.Router()

// GET /api/rates?base=SGD  ->  { base: 'SGD', date: '2026-10-09', rates: { SGD: 1, KRW: 1031.2, JPY: 115.4, ... } }
// Frankfurter: free exchange rates from the European Central Bank, no key needed.
// Rates change once a day, so each base currency is saved for 6 hours (see cache.js).
// If both sources fail, the last saved rates are used.
const SIX_HOURS = 6 * 60 * 60 * 1000
const SOURCES = [
  (base) => 'https://api.frankfurter.dev/v1/latest?base=' + base,
  (base) => 'https://api.frankfurter.app/latest?from=' + base
]

router.get('/', requireAuth, async (req, res) => {
  const base = String(req.query.base || 'SGD').toUpperCase()
  if (!/^[A-Z]{3}$/.test(base)) return res.status(400).json({ message: 'Currency must be a 3-letter code like SGD.' })

  try {
    const data = await remembered('rates|' + base, SIX_HOURS, async () => {
      let lastError = null
      for (const source of SOURCES) {
        try {
          const response = await ask('frankfurter', source(base), { timeout: 6000 })
          if (!response.ok) throw new Error('status ' + response.status)
          const json = await response.json()
          return { base, date: json.date, rates: { ...json.rates, [base]: 1 } }
        } catch (err) {
          console.error('Exchange rates failed:', err.message)
          lastError = err
        }
      }
      throw lastError
    })
    res.json(data)
  } catch (err) {
    res.status(502).json({ message: 'Exchange rates are unavailable right now.' })
  }
})

export default router
