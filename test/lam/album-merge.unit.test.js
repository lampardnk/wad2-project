// Unit: two people changing photo albums at the same time both keep their change
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeById } from '../../server/merge.js'

test('an album added by one person and renamed by another are both kept', () => {
  const base = [{ id: 'a1', name: 'Day 1', icon: '📍' }]
  const latest = [{ id: 'a1', name: 'Day 1', icon: '📍' }, { id: 'a2', name: 'Food', icon: '🍜' }] // Amy added Food
  const mine = [{ id: 'a1', name: 'Shibuya', icon: '📍' }] // Ben renamed Day 1

  assert.deepEqual(mergeById(latest, base, mine, ['name', 'icon']).map((a) => a.name), ['Shibuya', 'Food'])
})
