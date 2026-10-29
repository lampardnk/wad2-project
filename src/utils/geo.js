// Straight-line distance between two { lat, lon } points, in km (used by the app and the server)
export function kmBetween(a, b) {
  const r = Math.PI / 180
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}
