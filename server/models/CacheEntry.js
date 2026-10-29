import mongoose from 'mongoose'

// An answer from an outside service (route times, place search, weather, exchange rates), see cache.js
const cacheEntrySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // 'routes|taipei 101|jiufen|...'
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true }, // fresh until then
  removeAt: { type: Date, expires: 0 } // MongoDB deletes it then (kept a while after expiring, as a fallback)
})

export default mongoose.model('CacheEntry', cacheEntrySchema)
