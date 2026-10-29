// End to end: in a real browser, a packing item ticked on the Packing tab is still ticked after a reload.
// Starts its own server (on :3000, with an in-memory MongoDB) and the Vite app, so stop `pnpm dev` first.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright'
import { startDb, stopDb } from './helpers.js'

const root = new URL('../../', import.meta.url).pathname
const APP = 'http://127.0.0.1:5199'
let server, vite, browser

// Start a command and wait until it prints `ready`
function run(cmd, args, env, ready) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env } })
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes(ready) && resolve(child))
    child.on('exit', (code) => reject(new Error(cmd + ' exited with ' + code)))
  })
}

before(async () => {
  const uri = await startDb()
  server = await run('node', ['server/index.js'], { MONGODB_URI: uri, PORT: '3000' }, 'Server running')
  vite = await run('node', ['node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort', '--host', '127.0.0.1'], {}, 'Local')
  browser = await chromium.launch()
})
after(async () => {
  await browser?.close()
  server?.kill()
  vite?.kill()
  await stopDb()
})

test('a ticked packing item stays ticked after reloading the page', async () => {
  const api = (path, body, token) => fetch(APP + '/api' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) }, body: JSON.stringify(body)
  }).then((r) => r.json())
  const login = await api('/auth/register', { name: 'Lam', username: 'lam_e2e', email: 'lam@e2e.test', password: 'password123' })
  const trip = await api('/trips', { name: 'Tokyo week', destination: 'Tokyo, Japan', startDate: '2026-12-01', endDate: '2026-12-05' }, login.token)

  const page = await browser.newPage()
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(user))
  }, login)
  await page.goto(APP + '/trip/' + (trip.id || trip._id))
  await page.getByRole('tab', { name: 'Packing' }).click()
  await page.getByTestId('packing-build').click() // new trip: build the list first

  const first = page.getByTestId('packing-check').first()
  assert.equal(await first.isChecked(), false)
  const saved = page.waitForResponse((r) => r.url().includes('/packing') && r.request().method() === 'PUT')
  await first.check()
  await saved

  await page.reload()
  await page.getByRole('tab', { name: 'Packing' }).click()
  assert.equal(await page.getByTestId('packing-check').first().isChecked(), true)
})
