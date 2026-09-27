import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ORBIT_DEMO_GROUPS, cloneOrbitGroups, groupMinutes,
  moveOrbitGroup, moveOrbitTask, orbitDayGroups,
} from '../src/xixi/orbitGroups.ts'

const ids = items => items.map(item => item.id)
const dayIds = (groups, day) => ids(orbitDayGroups(groups, day))
const fixture = () => [
  { id: 'a', title: '今天的一组', day: 0, project: '相同项目', tasks: [
    { id: 'a1', title: '第一步', minutes: 10 },
    { id: 'a2', title: '第二步', minutes: 20 },
    { id: 'a3', title: '第三步', minutes: 30 },
  ] },
  { id: 'b', title: '今天的另一组', day: 0, tasks: [{ id: 'b1', title: '整理', minutes: 15 }] },
  { id: 'c', title: '明天的一组', day: 1, project: '相同项目', tasks: [{ id: 'c1', title: '回顾', minutes: 25 }] },
  { id: 'd', title: '明天的另一组', day: 1, tasks: [] },
  { id: 'e', title: '后天的一组', day: 2, tasks: [] },
]

function freezeGroups(groups) {
  for (const group of groups) {
    group.tasks.forEach(Object.freeze)
    Object.freeze(group.tasks)
    Object.freeze(group)
  }
  return Object.freeze(groups)
}

test('demo groups belong to one of three days and have independent editable clones', () => {
  assert.deepEqual([0, 1, 2].map(day => orbitDayGroups(ORBIT_DEMO_GROUPS, day).length), [3, 3, 2])
  assert.equal(new Set(ids(ORBIT_DEMO_GROUPS)).size, ORBIT_DEMO_GROUPS.length)
  const tasks = ORBIT_DEMO_GROUPS.flatMap(group => group.tasks)
  assert.equal(new Set(ids(tasks)).size, tasks.length)
  assert.ok(ORBIT_DEMO_GROUPS.every(group => group.tasks.length >= 2 && group.tasks.length <= 3))
  const first = cloneOrbitGroups()
  const second = cloneOrbitGroups()
  assert.deepEqual(first, ORBIT_DEMO_GROUPS)
  first[0].title = '自己的分组'
  first[0].tasks[0].title = '自己的任务'
  first[0].tasks.push({ id: 'new', title: '新增任务', minutes: 5 })
  assert.deepEqual(second, ORBIT_DEMO_GROUPS)
})

test('cross-day move changes only the chosen group day and retains its identity, metadata, and tasks', () => {
  const source = freezeGroups(fixture())
  const before = structuredClone(source)
  const result = moveOrbitGroup(source, 'a', 1, 1)
  assert.deepEqual(dayIds(result, 0), ['b'])
  assert.deepEqual(dayIds(result, 1), ['c', 'a', 'd'])
  assert.deepEqual(dayIds(result, 2), ['e'])
  const moved = result.find(group => group.id === 'a')
  assert.deepEqual(moved, { ...source[0], day: 1 })
  assert.equal(moved.tasks, source[0].tasks)
  assert.equal(result.filter(group => group.day !== source.find(original => original.id === group.id).day).length, 1)
  for (const original of source.slice(1)) assert.equal(result.find(group => group.id === original.id), original)
  assert.deepEqual(source, before)
  assert.notEqual(result, source)
})

test('same-day positions are counted after removal, in both directions', () => {
  const source = freezeGroups(fixture())
  const forward = moveOrbitGroup(source, 'a', 0, 1)
  assert.deepEqual(dayIds(forward, 0), ['b', 'a'])
  assert.equal(forward.find(group => group.id === 'a'), source[0])
  assert.deepEqual(moveOrbitGroup(forward, 'a', 0, 0), source)
  assert.deepEqual(moveOrbitGroup(source, 'a', 0, 0), source)
})

test('target positions are bounded to the selected day, including non-finite values', () => {
  const source = freezeGroups(fixture())
  for (const index of [-10, -Infinity, NaN]) {
    assert.deepEqual(dayIds(moveOrbitGroup(source, 'a', 1, index), 1), ['a', 'c', 'd'])
  }
  for (const index of [100, Infinity]) {
    assert.deepEqual(dayIds(moveOrbitGroup(source, 'a', 1, index), 1), ['c', 'd', 'a'])
  }
  assert.deepEqual(dayIds(moveOrbitGroup(source, 'a', 1, 1.9), 1), ['c', 'a', 'd'])
})

test('moving into an empty day creates its position without losing another day', () => {
  const source = freezeGroups(fixture().filter(group => group.day !== 1))
  const result = moveOrbitGroup(source, 'a', 1, 100)
  assert.deepEqual(ids(result), ['b', 'a', 'e'])
  assert.deepEqual(dayIds(result, 1), ['a'])
  assert.deepEqual(moveOrbitGroup([], 'missing', 0, 0), [])
})

test('all demo group moves preserve every group and task exactly once', () => {
  const source = freezeGroups(cloneOrbitGroups())
  for (const chosen of source) for (const day of [0, 1, 2]) for (const index of [-1, 0, 1, 2, 20]) {
    const result = moveOrbitGroup(source, chosen.id, day, index)
    assert.deepEqual(ids(result).sort(), ids(source).sort())
    for (const group of result) {
      const original = source.find(candidate => candidate.id === group.id)
      assert.equal(group.tasks, original.tasks)
      assert.equal(group.day, group.id === chosen.id ? day : original.day)
    }
    for (const otherDay of [0, 1, 2].filter(candidate => candidate !== day)) {
      assert.deepEqual(dayIds(result, otherDay), dayIds(source, otherDay).filter(id => id !== chosen.id))
    }
  }
})

test('unknown group and task identifiers leave all data intact', () => {
  const source = freezeGroups(fixture())
  assert.deepEqual(moveOrbitGroup(source, 'missing', 2, 0), source)
  assert.deepEqual(moveOrbitTask(source, 'missing', 'a1', 0), source)
  assert.deepEqual(moveOrbitTask(source, 'a', 'missing', 0), source)
  assert.deepEqual(moveOrbitTask(source, 'b', 'a1', 0), source)
})

test('task reorder is immutable and cannot change another group or its day', () => {
  const source = freezeGroups(fixture())
  const before = structuredClone(source)
  const result = moveOrbitTask(source, 'a', 'a1', 2)
  assert.deepEqual(ids(result[0].tasks), ['a2', 'a3', 'a1'])
  assert.equal(result[0].tasks[2], source[0].tasks[0])
  assert.deepEqual({ ...result[0], tasks: [] }, { ...source[0], tasks: [] })
  assert.notEqual(result[0], source[0])
  assert.notEqual(result[0].tasks, source[0].tasks)
  for (let index = 1; index < source.length; index++) assert.equal(result[index], source[index])
  assert.deepEqual(source, before)
  assert.deepEqual(moveOrbitTask(result, 'a', 'a1', 0), source)
})

test('task target positions clamp within their own group after removal', () => {
  const source = freezeGroups(fixture())
  assert.deepEqual(ids(moveOrbitTask(source, 'a', 'a2', -10)[0].tasks), ['a2', 'a1', 'a3'])
  assert.deepEqual(ids(moveOrbitTask(source, 'a', 'a2', Infinity)[0].tasks), ['a1', 'a3', 'a2'])
  assert.deepEqual(ids(moveOrbitTask(source, 'a', 'a2', NaN)[0].tasks), ['a2', 'a1', 'a3'])
  assert.deepEqual(moveOrbitTask(source, 'a', 'a2', 1.9), source)
  assert.deepEqual(moveOrbitTask(source, 'b', 'b1', 100), source)
})

test('day filtering preserves order and totals include all tasks', () => {
  const source = freezeGroups(fixture())
  assert.deepEqual(dayIds(source, 1), ['c', 'd'])
  assert.equal(groupMinutes(source[0]), 60)
  assert.equal(groupMinutes(source[3]), 0)
  const filtered = orbitDayGroups(source, 0)
  filtered.pop()
  assert.equal(source.length, 5)
})
