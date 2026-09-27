import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeHorizonGroups, moveHorizonTaskToGroup, renameHorizonGroup, splitHorizonTask } from '../src/xixi/horizonGrouping.ts'

const task = (id, extra = {}) => ({ id, title: `事项 ${id}`, minutes: 20, ...extra })
const group = (id, day, ids) => ({ id, title: `组 ${id}`, day, tasks: ids.map(id => task(id)) })
const fixture = () => [group('a', 0, ['1', '2']), group('b', 0, ['3', '4']), group('c', 1, ['5']), group('d', 2, ['6'])]
const allIds = groups => groups.flatMap(group => group.tasks.map(task => task.id)).sort()
const unchanged = groups => JSON.stringify(groups)
function accepted(result) { assert.equal(result.ok, true, result.reason); return result.groups }
function integrity(before, after) {
  assert.deepEqual(allIds(after), allIds(before), 'every task survives exactly once')
  assert.equal(new Set(allIds(after)).size, allIds(after).length)
  assert.ok(after.every(group => group.tasks.length >= 1 && group.tasks.length <= 6))
  assert.equal(new Set(after.map(group => group.id)).size, after.length)
}

test('rename keeps group and task identities, accepts trimmed names, rejects blank/long names', () => {
  const before = fixture(), snapshot = unchanged(before)
  const next = accepted(renameHorizonGroup(before, 'a', '  数学复习  '))
  assert.equal(next[0].title, '数学复习'); assert.equal(next[0].id, 'a')
  assert.strictEqual(next[0].tasks, before[0].tasks)
  assert.strictEqual(next[1], before[1])
  assert.equal(renameHorizonGroup(before, 'a', '  ').ok, false)
  assert.equal(renameHorizonGroup(before, 'a', '字'.repeat(81)).ok, false)
  assert.equal(renameHorizonGroup(before, 'a', '字'.repeat(80)).ok, true)
  assert.equal(renameHorizonGroup(before, 'gone', '新名字').ok, false)
  assert.equal(unchanged(before), snapshot)
  integrity(before, next)
})

test('renaming to the same name is idempotent without replacing group objects', () => {
  const before = fixture(), next = accepted(renameHorizonGroup(before, 'a', before[0].title))
  assert.deepEqual(next, before); assert.strictEqual(next[0], before[0])
  assert.deepEqual(accepted(renameHorizonGroup(next, 'a', before[0].title)), next)
})

test('merge preserves destination id/name and appends source tasks without changing their order', () => {
  const before = fixture(), snapshot = unchanged(before)
  const next = accepted(mergeHorizonGroups(before, 'a', 'b'))
  assert.deepEqual(next.map(group => group.id), ['b', 'c', 'd'])
  assert.equal(next[0].title, '组 b')
  assert.deepEqual(next[0].tasks.map(task => task.id), ['3', '4', '1', '2'])
  assert.strictEqual(next[0].tasks[2], before[0].tasks[0])
  assert.equal(unchanged(before), snapshot)
  integrity(before, next)
})

test('merge is restricted to one day and never exceeds six tasks', () => {
  const before = [group('a', 0, ['1', '2', '3']), group('b', 0, ['4', '5', '6']), group('c', 1, ['7'])]
  integrity(before, accepted(mergeHorizonGroups(before, 'a', 'b')))
  const crowded = [group('a', 0, ['1', '2', '3', '7']), before[1]]
  assert.equal(mergeHorizonGroups(crowded, 'a', 'b').ok, false)
  assert.match(mergeHorizonGroups(before, 'a', 'c').reason, /同一天/)
  assert.equal(mergeHorizonGroups(before, 'gone', 'a').ok, false)
})

test('merging a group into itself is a no-op and retrying a completed merge cannot duplicate tasks', () => {
  const before = fixture()
  assert.deepEqual(accepted(mergeHorizonGroups(before, 'a', 'a')), before)
  const next = accepted(mergeHorizonGroups(before, 'a', 'b')), snapshot = unchanged(next)
  assert.equal(mergeHorizonGroups(next, 'a', 'b').ok, false)
  assert.equal(unchanged(next), snapshot)
  integrity(before, next)
})

test('move across dates keeps task metadata and other group identities stable', () => {
  const before = fixture(); before[0].tasks[0] = task('1', { needsReschedule: true })
  const snapshot = unchanged(before), next = accepted(moveHorizonTaskToGroup(before, 'a', '1', 'c'))
  assert.deepEqual(next[0].tasks.map(task => task.id), ['2'])
  assert.deepEqual(next[2].tasks.map(task => task.id), ['5', '1'])
  assert.equal(next[2].day, 1); assert.strictEqual(next[2].tasks[1], before[0].tasks[0])
  assert.equal(next[2].tasks[1].needsReschedule, true)
  assert.strictEqual(next[1], before[1]); assert.equal(unchanged(before), snapshot)
  integrity(before, next)
})

test('moving the final task removes only its empty source group', () => {
  const before = fixture(), next = accepted(moveHorizonTaskToGroup(before, 'c', '5', 'd'))
  assert.deepEqual(next.map(group => group.id), ['a', 'b', 'd'])
  assert.deepEqual(next[2].tasks.map(task => task.id), ['6', '5'])
  integrity(before, next)
})

test('move capacity/missing-target failures are atomic and repeated movement cannot lose items', () => {
  const before = [group('a', 0, ['1']), group('b', 0, ['2', '3', '4', '5', '6', '7'])], snapshot = unchanged(before)
  assert.equal(moveHorizonTaskToGroup(before, 'a', '1', 'b').ok, false)
  assert.equal(moveHorizonTaskToGroup(before, 'a', '1', 'gone').ok, false)
  assert.equal(moveHorizonTaskToGroup(before, 'a', 'gone', 'b').ok, false)
  assert.equal(unchanged(before), snapshot)
  assert.deepEqual(accepted(moveHorizonTaskToGroup(before, 'a', '1', 'a')), before)
  const next = accepted(moveHorizonTaskToGroup(before, 'b', '2', 'a'))
  assert.equal(moveHorizonTaskToGroup(next, 'b', '2', 'a').ok, false)
  integrity(before, next)
})

test('split inserts after source, retains source identity, date, project, and task metadata', () => {
  const before = fixture(); before[0].project = '数学'; before[0].tasks[1].needsReschedule = true
  const snapshot = unchanged(before), next = accepted(splitHorizonTask(before, 'a', '2', () => 'horizon-test-new'))
  assert.deepEqual(next.map(group => group.id), ['a', 'horizon-test-new', 'b', 'c', 'd'])
  assert.equal(next[0].title, before[0].title)
  assert.equal(next[1].day, 0); assert.equal(next[1].title, '事项 2'); assert.equal(next[1].project, '数学')
  assert.strictEqual(next[1].tasks[0], before[0].tasks[1])
  assert.equal(next[1].tasks[0].needsReschedule, true)
  assert.equal(unchanged(before), snapshot)
  integrity(before, next)
})

test('splitting a singleton is idempotent and never allocates another group id', () => {
  const before = fixture()
  const next = accepted(splitHorizonTask(before, 'c', '5', () => { throw Error('must not allocate') }))
  assert.deepEqual(next, before); assert.strictEqual(next[2], before[2])
  assert.deepEqual(accepted(splitHorizonTask(next, 'c', '5')), next)
})

test('split creates a UUID-based prefixed id, bounds titles, and rejects collisions atomically', () => {
  const before = fixture(); before[0].tasks[0].title = '字'.repeat(100)
  const next = accepted(splitHorizonTask(before, 'a', '1'))
  assert.match(next[1].id, /^horizon-custom-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/)
  assert.equal([...next[1].title].length, 80)
  assert.equal(splitHorizonTask(before, 'a', '1', () => 'b').ok, false)
  assert.equal(splitHorizonTask(before, 'a', '1', () => '').ok, false)
  assert.equal(splitHorizonTask(before, 'a', 'gone').ok, false)
  assert.equal(splitHorizonTask(before, 'gone', '1').ok, false)
  integrity(before, next)
})

test('existing duplicate membership is rejected instead of being silently copied or deleted', () => {
  const before = [group('a', 0, ['1']), group('b', 0, ['1'])], snapshot = unchanged(before)
  assert.equal(mergeHorizonGroups(before, 'a', 'b').ok, false)
  assert.equal(moveHorizonTaskToGroup(before, 'a', '1', 'b').ok, false)
  assert.equal(unchanged(before), snapshot)
})

test('a deterministic series of split, merge, and cross-day edits retains every task once', () => {
  let current = fixture(); const before = structuredClone(current)
  for (let iteration = 0; iteration < 50; iteration++) {
    const source = current.find(group => group.tasks.length > 1)
    if (source) current = accepted(splitHorizonTask(current, source.id, source.tasks[0].id, () => `horizon-test-${iteration}`))
    const from = current[iteration % current.length]
    const to = current.find(group => group.id !== from.id && group.tasks.length < 6)
    if (to) current = accepted(moveHorizonTaskToGroup(current, from.id, from.tasks[0].id, to.id))
    integrity(before, current)
  }
})
