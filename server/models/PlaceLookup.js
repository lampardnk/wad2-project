import mongoose from 'mongoose'

// Where a place is (map pins, safety), saved so each place is only looked up once, even after a restart
const placeLookupSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // 'taipei 101|taipei, taiwan' (place|near, lowercase)
  place: { type: mongoose.Schema.Types.Mixed, default: null }, // { lat, lon, city, countryCode, countryName }; null = not found
  fetchedAt: { type: Date, default: Date.now }
})

export default mongoose.model('PlaceLookup', placeLookupSchema)
