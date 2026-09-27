import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-26'
const placement = db => db.getPlanner().blocks.map(({ id, date, start, end }) => ({ id, date, start, end })).sort((a, b) => a.id.localeCompare(b.id))
const draftOf = snapshot => snapshot.groups.map(group => ({ id: group.id, title: group.title, day: group.day, itemIds: group.tasks.map(task => task.id) }))
function fixture(t, { saved = false, at = '09:00' } = {}) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
  edit({ type: 'save-routine', routine: { id: 'free', title: '可用时段', kind: 'available', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  const math = db.createTask({ title: '数学练习', area: 'math' }), physics = db.createTask({ title: '物理实验', area: 'physics' })
  for (const [id, taskId, start, end, subject] of [
    ['math-a', math.id, '10:00', '10:30', 'math'],
    ['physics', physics.id, '11:00', '11:30', 'physics'],
    ['math-b', math.id, '12:00', '12:30', 'math'],
  ]) edit({ type: 'save-block', block: { id, taskId, date: DATE, start, end, locked: false,
    ...(saved ? { horizonGroupId: `horizon-saved-${subject}`, horizonGroupTitle: subject === 'math' ? '数学原分组' : '物理原分组' } : {}) } })
  let modelCalls = 0
  const service = createHorizonOrder({ db, now: () => new Date(`${DATE}T${at}:00+08:00`), complete: async () => {
    modelCalls++
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"updates":[],"changes":[]}' } }] }
  } })
  const request = transform => {
    const snapshot = service.list({ date: DATE })
    return { date: DATE, expectedRevision: snapshot.revision, snapshotKey: snapshot.snapshotKey, requestId: randomUUID(), groups: transform(draftOf(snapshot)) }
  }
  return { db, service, request, calls: () => modelCalls }
}
const renameMath = groups => groups.map(group => group.itemIds.includes('math-a') ? { ...group, title: '三角函数复习' } : group)

for (const saved of [false, true]) test(`${saved ? 'saved' : 'fallback'} title-only edit preserves interleaved original times and is undoable without a model call`, async t => {
  const f = fixture(t, { saved }), snapshot = f.service.list({ date: DATE })
  assert.deepEqual(snapshot.groups.flatMap(group => group.tasks.map(task => task.id)), ['math-a', 'math-b', 'physics'], 'fixture group order deliberately differs from chronological block order')
  const before = placement(f.db), blocksBefore = structuredClone(f.db.getPlanner().blocks), titlesBefore = snapshot.groups.map(group => [group.id, group.title])
  const events = [], input = f.request(renameMath)
  const result = await f.service.apply(input, { onEvent: event => events.push(event) })
  assert.equal(f.calls(), 0, 'renaming must not spend time on a schedule model')
  assert.deepEqual(placement(f.db), before, 'renaming must not implicitly flatten groups into a new chronological schedule')
  assert.ok(result.operation?.undoable)
  assert.equal(f.db.listOperations().length, 1)
  const after = f.db.getPlanner().blocks
  assert.equal(after.find(block => block.id === 'math-a').horizonGroupTitle, '三角函数复习')
  assert.equal(after.find(block => block.id === 'math-b').horizonGroupTitle, '三角函数复习')
  assert.equal(after.find(block => block.id === 'math-a').horizonGroupId, input.groups.find(group => group.itemIds.includes('math-a')).id)
  assert.ok(!events.some(event => event.type === 'phase' && ['waiting', 'thinking', 'receiving'].includes(event.phase)))
  const replay = await f.service.apply(input)
  assert.equal(replay.operation.id, result.operation.id); assert.equal(f.calls(), 0); assert.equal(f.db.listOperations().length, 1)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, blocksBefore)
  assert.deepEqual(f.service.list({ date: DATE }).groups.map(group => [group.id, group.title]), titlesBefore)
})

test('new intelligent group IDs with identical membership/order save metadata without changing times or calling the model', async t => {
  const f = fixture(t), before = placement(f.db), blocksBefore = structuredClone(f.db.getPlanner().blocks)
  const input = f.request(groups => groups.map((group, index) => ({ ...group, id: `horizon-smart-${index}`, title: `智能建议 ${index + 1}` })))
  const result = await f.service.apply(input)
  assert.equal(f.calls(), 0)
  assert.deepEqual(placement(f.db), before)
  assert.ok(result.operation?.undoable)
  for (const group of input.groups) for (const id of group.itemIds) {
    const block = f.db.getPlanner().blocks.find(block => block.id === id)
    assert.equal(block.horizonGroupId, group.id); assert.equal(block.horizonGroupTitle, group.title)
  }
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, blocksBefore)
})

test('overdue unfinished sessions still take the scheduling path even if the only draft edit is a title', async t => {
  const f = fixture(t, { saved: true, at: '10:01' }), snapshot = f.service.list({ date: DATE })
  assert.equal(snapshot.items.find(item => item.id === 'math-a').needsReschedule, true)
  const before = placement(f.db), events = []
  const result = await f.service.apply(f.request(renameMath), { onEvent: event => events.push(event) })
  assert.equal(f.calls(), 1, 'overdue work must be rescheduled instead of taking a metadata-only shortcut')
  assert.ok(events.some(event => event.type === 'phase' && event.phase === 'waiting'))
  assert.notDeepEqual(placement(f.db), before)
  assert.ok(f.db.getPlanner().blocks.every(block => block.start > '10:01'))
  assert.ok(result.operation?.undoable)
})

test('changing group order continues to use the existing scheduling and model path', async t => {
  const f = fixture(t), before = placement(f.db)
  const result = await f.service.apply(f.request(groups => [...groups].reverse()))
  assert.equal(f.calls(), 1)
  assert.notDeepEqual(placement(f.db), before)
  const blocks = f.db.getPlanner().blocks
  assert.ok(blocks.find(block => block.id === 'physics').end <= blocks.find(block => block.id === 'math-a').start)
  assert.ok(result.operation?.undoable)
})

test('changing membership still schedules even when flattened item order remains identical', async t => {
  const f = fixture(t), original = f.service.list({ date: DATE }), beforeIds = original.groups.flatMap(group => group.tasks.map(task => task.id))
  const input = f.request(groups => groups.flatMap(group => group.itemIds.includes('math-a') ? [
    { ...group, itemIds: ['math-a'] },
    { ...group, id: 'horizon-split-math', title: '数学第二段', itemIds: ['math-b'] },
  ] : [group]))
  assert.deepEqual(input.groups.flatMap(group => group.itemIds), beforeIds)
  const result = await f.service.apply(input)
  assert.equal(f.calls(), 1, 'same flattened order is not sufficient to classify a split/merge as metadata-only')
  assert.ok(result.operation?.undoable)
  assert.equal(result.groups.length, 3)
})
