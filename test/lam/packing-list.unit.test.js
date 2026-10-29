// Unit: the packing list is built from the trip's length, weather and extras
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPackingList } from '../../src/packingList.js'

test('packing list follows the weather and caps clothes when you can do laundry', () => {
  const list = buildPackingList({ days: 10, weather: ['rain'], extras: ['laundry'] })
  const qty = (name) => list.find((it) => it.name === name)?.qty

  assert.equal(qty('Compact umbrella'), 1)
  assert.equal(qty('T-shirts / tops'), 4) // washing halfway: 4, not 10
  assert.equal(qty('Sunscreen'), undefined) // not a hot trip
})
