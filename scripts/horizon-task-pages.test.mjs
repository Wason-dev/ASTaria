import assert from 'node:assert/strict'
import test from 'node:test'
import { horizonTaskPageSize, horizonTaskPage, horizonPagedDropIndex } from '../src/xixi/horizonTaskPages.ts'
import { horizonTaskSlot, previewHorizonTasks } from '../src/xixi/horizonTasks.ts'

test('responsive task pages preserve every item and a readable label gap', () => {
  const ids = Array.from({ length: 19 }, (_, i) => String(i))
  for (const width of [240, 320, 390, 520, 650, 800, 1280, 1920]) {
    const size = horizonTaskPageSize(width), { total } = horizonTaskPage(ids.length, size, 0)
    const visited = Array.from({ length: total }, (_, page) => {
      const { start, end } = horizonTaskPage(ids.length, size, page)
      return ids.slice(start, end)
    }).flat()
    assert.deepEqual(visited, ids)
    assert.ok(size >= 1 && size <= 6)
    const nameWidth = width <= 520 ? 120 : width <= 800 ? 150 : 190
    assert.ok(width * .8 / size >= nameWidth + 24)
  }
  assert.equal(horizonTaskPageSize(390), 2)
  assert.equal(horizonTaskPageSize(1280), 4)
  assert.deepEqual(horizonTaskPage(0, 2, 5), { page:0, total:1, start:0, end:0 })
})

test('dropping onto the same anchor on any page keeps the global order', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  for (const size of [1, 2, 3, 4, 6]) for (let index = 0; index < ids.length; index++) {
    const page = Math.floor(index / size), { start, end } = horizonTaskPage(ids.length, size, page)
    const x = horizonTaskSlot(index - start, end - start) * 390
    assert.equal(horizonPagedDropIndex(x, 390, ids, ids[index], page, size), index)
  }
})

test('cross-page drops insert into the full group without losing hidden items', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f']
  const forward = horizonPagedDropIndex(390, 390, ids, 'a', 2, 2)
  const backward = horizonPagedDropIndex(0, 390, ids, 'f', 0, 2)
  assert.equal(forward, 5)
  assert.equal(backward, 0)
  assert.deepEqual(previewHorizonTasks(ids, 'a', forward), ['b', 'c', 'd', 'e', 'f', 'a'])
  assert.deepEqual(previewHorizonTasks(ids, 'f', backward), ['f', 'a', 'b', 'c', 'd', 'e'])
  assert.equal(horizonPagedDropIndex(0, 390, ids, 'a', 1, 2), 1)
  assert.equal(horizonPagedDropIndex(390, 390, ids, 'f', 1, 2), 4)
})
