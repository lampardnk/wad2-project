import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ask, remembered, HOUR } from '../outside.js'

// GET /api/icons/Backpack -> a 3D picture of a backpack (PNG)
// The pictures are Microsoft's free Fluent Emoji 3D set (MIT licence, github.com/microsoft/fluentui-emoji).
// Each one is downloaded the first time it's asked for, then saved in server/data/icons, so it's only fetched once.
const router = express.Router()
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'icons')
const BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/'

router.get('/:name', async (req, res) => {
  const name = String(req.params.name || '')
  // Only plain names like "Hiking boot" or "T-shirt" (nothing that could reach other folders)
  if (!/^[A-Za-z0-9][A-Za-z0-9 \-']{0,40}$/.test(name)) return res.status(400).end()
  const file = path.join(DIR, name.toLowerCase().replace(/[ ']/g, '_') + '.png')
  res.set('Cache-Control', 'public, max-age=604800') // browsers keep it for a week

  if (fs.existsSync(file)) return res.type('png').sendFile(file)

  // A picture that doesn't exist is remembered for an hour (false); a found one is saved as a file instead
  try {
    await remembered('icon-missing|' + name, HOUR, async () => {
      // "Hiking boot" -> assets/Hiking boot/3D/hiking_boot_3d.png
      const url = BASE + encodeURIComponent(name) + '/3D/' + encodeURIComponent(name.toLowerCase().replace(/ /g, '_')) + '_3d.png'
      const response = await ask('github', url)
      if (response.status === 404) return false
      if (!response.ok) throw new Error('HTTP ' + response.status)
      fs.mkdirSync(DIR, { recursive: true })
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()))
    })
  } catch (err) {
    // GitHub is busy: the app shows the normal emoji this time
  }
  if (fs.existsSync(file)) return res.type('png').sendFile(file)
  res.status(404).end() // the app shows the normal emoji instead
})

export default router
