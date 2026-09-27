import test from 'node:test'
import assert from 'node:assert/strict'
import { horizonDate, horizonDraft, horizonPage } from '../src/xixi/horizonOrder.ts'
import { moveOrbitGroup } from '../src/xixi/orbitGroups.ts'

const groups = Array.from({ length: 14 }, (_, i) => ({ id: `group-${i}`, title: '数学', day: i < 11 ? 0 : 1,
  tasks: [{ id: `block-${i}`, title: '同一任务的不同时间段', minutes: 30 }] }))

test('paged horizon preserves every real block, day order and source draft', () => {
  const before = structuredClone(groups)
  for (const size of [1, 2, 5]) {
    const ids = Array.from({ length: Math.ceil(11 / size) }, (_, page) => horizonPage(groups, 0, page, size).visible).flat().map(g => g.id)
    assert.deepEqual(ids, groups.slice(0, 11).map(g => g.id))
    assert.equal(horizonPage(groups, 0, 99, size).page, Math.ceil(11 / size) - 1)
    assert.deepEqual(horizonPage(groups, 2, 99, size).visible, [])
  }
  const moved = moveOrbitGroup(groups, 'group-0', 1, 2)
  const draft = horizonDraft(moved)
  assert.equal(draft.find(g => g.id === 'group-0').day, 1)
  assert.deepEqual(draft.filter(g => g.day === 1).map(g => g.id), ['group-11', 'group-12', 'group-0', 'group-13'])
  assert.deepEqual(draft.flatMap(g => g.itemIds).sort(), before.flatMap(g => g.tasks.map(t => t.id)).sort())
  assert.deepEqual(groups, before)
})

test('horizon draft treats blocks independently and normalizes only cross-day group order', () => {
  const original = horizonDraft(groups)
  assert.deepEqual(horizonDraft([...groups.slice(11), ...groups.slice(0, 11)]), original)
  assert.notDeepEqual(horizonDraft(moveOrbitGroup(groups, 'group-1', 0, 0)), original)
  assert.equal(new Set(original.flatMap(g => g.itemIds)).size, 14)
  assert.equal(original[0].title, '数学')
  assert.notDeepEqual(horizonDraft(groups.map((group,index)=>index===0?{...group,title:'手动命名'}:group)),original,'renaming a group is a real draft change')
})

test('day labels follow the captured date across month and year boundaries', () => {
  assert.equal(horizonDate('2026-09-30', 1), '2026-10-01')
  assert.equal(horizonDate('2026-12-31', 2), '2027-01-02')
})
