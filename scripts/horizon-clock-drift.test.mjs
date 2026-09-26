import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-26'
const response = changes => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ changes }) } }] })
const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const fixture = (t, { windowEnd = '22:00', firstStart = '08:00', second = true } = {}) => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let at = new Date(`${DATE}T09:59:55+08:00`)
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) edit({ type: 'delete-routine', id: row.id })
  edit({ type: 'save-routine', routine: { id: 'available', title: '上午空档', kind: 'available', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: windowEnd, location: '', items: [], enabled: true } })
  const first = db.createTask({ title: '数学错题', area: 'math' })
  edit({ type: 'save-block', block: { id: 'first', taskId: first.id, date: DATE, start: firstStart, end: firstStart.slice(0, 2) + ':30', locked: false } })
  if (second) {
    const next = db.createTask({ title: '物理作业', area: 'physics' })
    edit({ type: 'save-block', block: { id: 'second', taskId: next.id, date: DATE, start: '11:00', end: '11:30', locked: false } })
  }
  const request = (svc, mutate = groups => groups) => {
    const snapshot = svc.list({ date: DATE })
    return { date: DATE, expectedRevision: snapshot.revision, snapshotKey: snapshot.snapshotKey, requestId: randomUUID(),
      groups: mutate(snapshot.groups.map(group => ({ id: group.id, title: group.title, day: group.day, itemIds: group.tasks.map(task => task.id) }))) }
  }
  return { db, edit, request, now: () => at, advance: clock => { at = new Date(`${DATE}T${clock}+08:00`) } }
}
const block = (f, id) => f.db.getPlanner().blocks.find(item => item.id === id)

for (const adjusted of [false, true]) test(`model waiting clock drift moves only expired starts while retaining ${adjusted ? 'a valid model adjustment' : 'the later original time'}`, async t => {
  const f = fixture(t), original = f.db.getPlanner(); let payload, calls = 0
  const svc = createHorizonOrder({ db: f.db, now: f.now, complete: async input => {
    calls++; payload = JSON.parse(input.messages[1].content)
    f.advance('10:00:10')
    return response(adjusted ? [{ index: 1, start: '12:00' }] : [])
  } })
  const input = f.request(svc), result = await svc.apply(input)
  assert.equal(payload.items[0].start, '10:00')
  assert.ok(result.operation)
  assert.equal(calls, 1)
  assert.equal(block(f, 'first').start, '10:01')
  assert.equal(block(f, 'second').start, adjusted ? '12:00' : '11:00')
  for (const item of f.db.getPlanner().blocks) {
    assert.equal(item.date, DATE)
    assert.equal(minute(item.end) - minute(item.start), 30)
    assert.ok(new Date(`${item.date}T${item.start}:00+08:00`) > f.now())
  }
  const replay = await svc.apply(input)
  assert.equal(replay.operation.id, result.operation.id)
  assert.equal(replay.replayed, true)
  assert.equal(calls, 1)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, original.blocks)
})

test('a newly elapsed original todo block changes the scope and still requires a refresh', async t => {
  const f = fixture(t, { firstStart: '10:00' }), before = f.db.getPlanner()
  const svc = createHorizonOrder({ db: f.db, now: f.now, complete: async () => {
    f.advance('10:00:10')
    return response([{ index: 0, start: '10:00' }, { index: 1, start: '10:30' }])
  } })
  await assert.rejects(svc.apply(f.request(svc, groups => [...groups].reverse())), /已有变化|刷新/u)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('clock drift does not silently shorten or spill a session when its window no longer fits', async t => {
  const f = fixture(t, { windowEnd: '10:30', second: false }), before = f.db.getPlanner()
  const svc = createHorizonOrder({ db: f.db, now: f.now, complete: async () => { f.advance('10:00:10'); return response([]) } })
  await assert.rejects(svc.apply(f.request(svc)), /空档|无法|不足|过去/u)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

for (const [label, changes] of [
  ['already past before model waiting', [{ index: 0, start: '09:30' }]],
  ['overlaps before model waiting', [{ index: 1, start: '10:10' }]],
]) test(`a model result that ${label} is rejected instead of being laundered by clock recovery`, async t => {
  const f = fixture(t), before = f.db.getPlanner()
  const svc = createHorizonOrder({ db: f.db, now: f.now, complete: async () => { f.advance('10:00:10'); return response(changes) } })
  await assert.rejects(svc.apply(f.request(svc)), /过去|先后顺序|冲突/u)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('clock drift never excuses a real planner edit made while waiting', async t => {
  const f = fixture(t); let externallyChanged
  const svc = createHorizonOrder({ db: f.db, now: f.now, complete: async () => {
    f.advance('10:00:10')
    f.edit({ type: 'save-day-event', event: { id: 'new-meeting', title: '临时会议', date: DATE, start: '10:00', end: '11:00', location: '', items: [] } })
    externallyChanged = f.db.getPlanner()
    return response([])
  } })
  await assert.rejects(svc.apply(f.request(svc)), /已有变化|更新/u)
  assert.deepEqual(f.db.getPlanner(), externallyChanged)
  assert.deepEqual(f.db.listOperations(), [])
})
