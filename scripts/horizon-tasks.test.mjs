import assert from 'node:assert/strict'
import test from 'node:test'
import { horizonTaskSlot, horizonTaskDropIndex, previewHorizonTasks } from '../src/xixi/horizonTasks.ts'

test('task slots remain inside the shared horizon, including a single task', () => {
  assert.equal(horizonTaskSlot(0, 1), .5)
  for (const width of [320, 390, 1280, 2048]) for (const count of [1, 2, 3, 8]) {
    const ids = Array.from({ length:count }, (_, i) => String(i))
    ids.forEach((id, index) => {
      const t = horizonTaskSlot(index, count)
      assert.ok(t > .1 && t < .9)
      assert.equal(horizonTaskDropIndex(t * width, width, ids, id), index, 'dropping back on the original slot is a no-op')
    })
  }
})
test('drag previews preserve all tasks and do not steer their own thresholds', () => {
  const original = ['a', 'b', 'c']
  const target = horizonTaskDropIndex(1150, 1280, original, 'a')
  assert.equal(target, 2)
  assert.deepEqual(previewHorizonTasks(original, 'a', target), ['b', 'c', 'a'])
  assert.deepEqual(original, ['a', 'b', 'c'])
  assert.equal(horizonTaskDropIndex(1150, 1280, original, 'a'), target)
  assert.equal(horizonTaskDropIndex(-100, 1280, original, 'c'), 0)
  assert.deepEqual(previewHorizonTasks(original, 'missing', 0), original)
  assert.deepEqual(previewHorizonTasks(original, 'a', -20), original)
})
