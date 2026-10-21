import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'

process.env.TZ = 'Asia/Shanghai'

const NOW = '2026-10-12T10:32:00+08:00'
const PAST = '2026-09-21', TODAY = '2026-10-12', FUTURE = '2026-10-13'
const routine = (patch = {}) => ({
  id: 'evening-break', title: '洗漱', kind: 'break', weekdays: [1, 2, 3, 4, 5],
  start: '20:30', end: '21:30', location: '', items: [], enabled: true, ...patch,
})
const at = (date, clock) => new Date(`${date}T${clock}:00`).toISOString()
const edit = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const snapshot = db => ({ planner: db.getPlanner(), tasks: db.listTasks(), outbox: db.sync.outbox() })

function pair(t, instant = NOW) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(instant).getTime() })
  const a = createDatabase(':memory:'), b = createDatabase(':memory:')
  t.after(() => { a.close(); b.close() })
  const send = (from, to) => {
    for (const op of from.sync.outbox()) {
      const result = to.sync.receive(op)
      assert.ok(['applied', 'duplicate'].includes(result), to.sync.pending().find(row => row.operationId === op.operationId)?.reason)
      from.sync.exported(op.operationId)
    }
  }
  for (const db of [a, b]) {
    db.listAreas(); db.getPlanner()
    db.sync.configure({ groupId: 'd'.repeat(32), directory: '/offline-fixture', mode: 'shared' })
  }
  send(a, b); send(b, a)
  const control = a.createTask({ title: '伴随日程同步的事项' })
  send(a, b)
  return { a, b, send, control }
}

function occupy(db, mode, date, start, end, { status = 'todo', locked = false } = {}) {
  const task = db.createTask({ title: '历史或未来占用', ...(mode === 'implicit'
    ? { startAt: at(date, start), estimateMin: (Date.parse(at(date, end)) - Date.parse(at(date, start))) / 60_000 } : {}) })
  if (mode === 'block') edit(db, { type: 'save-block', block: { id: `block-${task.id}`, taskId: task.id, date, start, end, locked } })
  if (status !== 'todo') db.updateTask(task.id, { status })
  return task.id
}

function incomingRoutine(f, entry = routine(), type = 'save-routine') {
  f.a.transaction(() => {
    f.a.updateTask(f.control.id, { title: '应与课表一起提交', notes: `同一个同步事务 ${f.a.getPlanner().revision}` })
    edit(f.a, type === 'import-routines' ? { type, routines: [entry] } : { type, routine: entry })
  })
  assert.equal(f.a.sync.outbox().length, 1)
  const op = f.a.sync.outbox()[0]
  assert.deepEqual(op.after.changes.map(change => change.entity).sort(), ['planner', 'tasks'])
  return op
}

function expectPending(f, op, reason) {
  const before = snapshot(f.b)
  assert.equal(f.b.sync.receive(op), 'pending')
  assert.match(f.b.sync.pending().find(row => row.operationId === op.operationId).reason, reason)
  assert.deepEqual(snapshot(f.b), before, 'planner, tasks, revision and outgoing operations roll back atomically')
  assert.equal(f.b.sync.status().receipts.some(row => row.operationId === op.operationId && row.outcome === 'applied'), false)
  assert.equal(f.b.sync.resolve(op.operationId, 'remote'), 'pending', 'choosing remote cannot bypass validation')
  assert.deepEqual(snapshot(f.b), before)
}

for (const type of ['save-routine', 'import-routines']) {
  test(`${type} syncs the reproduced September history without changing active, completed or locked blocks`, t => {
    const f = pair(t)
    occupy(f.a, 'block', PAST, '20:45', '21:15', { status: 'done', locked: true })
    occupy(f.a, 'block', '2026-10-08', '21:00', '21:30', { status: 'doing' })
    occupy(f.a, 'block', '2026-10-09', '20:30', '21:00', { locked: true })
    f.send(f.a, f.b)
    const before = snapshot(f.b), op = incomingRoutine(f, routine(), type)
    assert.equal(f.b.sync.receive(op), 'applied')
    assert.equal(f.b.sync.pending().length, 0)
    assert.deepEqual(f.b.getPlanner().routines.find(row => row.id === 'evening-break'), routine())
    assert.deepEqual(f.b.getPlanner().blocks, before.planner.blocks)
    assert.equal(f.b.getPlanner().revision, before.planner.revision + 1)
    assert.deepEqual(f.b.listTasks().filter(task => task.id !== f.control.id), before.tasks.filter(task => task.id !== f.control.id))
    assert.equal(f.b.getTask(f.control.id).title, '应与课表一起提交')
    assert.equal(f.b.sync.receive(op), 'duplicate')
    assert.deepEqual(f.b.sync.outbox(), before.outbox, 'receiving history does not echo changes back out')
  })
}

for (const mode of ['block', 'implicit']) for (const timing of [
  { name: 'the routine ended but the task is still running', taskEnd: '11:30', routineEnd: '10:00' },
  { name: 'the routine overlap ends exactly now', taskEnd: '11:30', routineEnd: '10:32' },
  { name: 'the task ended but the routine continues', taskEnd: '10:00', routineEnd: '11:30' },
  { name: 'the task overlap ends exactly now', taskEnd: '10:32', routineEnd: '11:30' },
]) {
  test(`today's ${mode} sync allows history when ${timing.name}`, t => {
    const f = pair(t)
    occupy(f.a, mode, TODAY, '09:00', timing.taskEnd, { status: 'doing', locked: true })
    f.send(f.a, f.b)
    const before = snapshot(f.b), op = incomingRoutine(f, routine({ start: '09:00', end: timing.routineEnd }))
    assert.equal(f.b.sync.receive(op), 'applied')
    assert.deepEqual(f.b.getPlanner().blocks, before.planner.blocks)
    assert.deepEqual(f.b.listTasks().filter(task => task.id !== f.control.id), before.tasks.filter(task => task.id !== f.control.id))
    assert.equal(f.b.sync.pending().length, 0)
  })
}

for (const mode of ['block', 'implicit']) for (const timing of [
  { name: 'ongoing today', date: TODAY, start: '09:00', end: '11:30', routineStart: '10:00', routineEnd: '11:00' },
  { name: 'in the future', date: FUTURE, start: '20:45', end: '21:15', routineStart: '20:30', routineEnd: '21:30' },
]) {
  test(`${mode} ${timing.name} still leaves the remote routine and accompanying task edit pending`, t => {
    const f = pair(t)
    // Only B knows this occupancy; A can legitimately save its weekly schedule.
    occupy(f.b, mode, timing.date, timing.start, timing.end, { locked: true })
    const op = incomingRoutine(f, routine({ start: timing.routineStart, end: timing.routineEnd }))
    expectPending(f, op, /课程、休息或固定活动/u)
  })
}

test('a completed future locked block remains occupied during synchronization', t => {
  const f = pair(t)
  occupy(f.b, 'block', FUTURE, '20:45', '21:15', { status: 'done', locked: true })
  expectPending(f, incomingRoutine(f), /课程、休息或固定活动/u)
})

test('a pending ongoing overlap applies when its overlap ends, retaining the locked task that continues afterward', t => {
  const f = pair(t)
  const taskId = occupy(f.b, 'block', TODAY, '09:00', '11:30', { status: 'doing', locked: true })
  const op = incomingRoutine(f, routine({ start: '09:00', end: '10:33' }))
  expectPending(f, op, /课程、休息或固定活动/u)
  const before = snapshot(f.b)
  t.mock.timers.tick(60_000)
  assert.equal(f.b.sync.resolve(op.operationId, 'remote'), 'applied')
  assert.equal(f.b.sync.pending().length, 0)
  assert.deepEqual(f.b.getPlanner().blocks, before.planner.blocks)
  assert.equal(f.b.getTask(taskId).status, 'doing')
  assert.equal(f.b.getPlanner().blocks[0].locked, true)
  assert.equal(f.b.getTask(f.control.id).title, '应与课表一起提交')
})

for (const mode of ['block', 'implicit']) for (const due of ['2026-09-20', '2026-09-21T21:00:00+08:00']) {
  test(`past ${mode} still checks the ${due.length === 10 ? 'local date' : 'precise'} deadline before applying a weekly routine`, t => {
    const f = pair(t)
    const taskId = occupy(f.a, mode, PAST, '20:45', '21:15')
    f.send(f.a, f.b)
    f.a.transaction(() => {
      f.a.updateTask(taskId, { due, notes: '必须与失败的日程一起回滚' })
      edit(f.a, { type: 'save-routine', routine: routine() })
    })
    expectPending(f, f.a.sync.outbox()[0], /截止/u)
  })
}

test('past explicit blocks still conflict with unplanned startAt tasks', t => {
  const f = pair(t)
  occupy(f.a, 'block', PAST, '20:45', '21:15')
  f.send(f.a, f.b)
  occupy(f.b, 'implicit', PAST, '21:00', '21:30')
  expectPending(f, incomingRoutine(f), /已有任务的开始时间和预计用时冲突/u)
})

test('past implicit tasks still conflict with each other despite an ended periodic overlap', t => {
  const f = pair(t)
  occupy(f.a, 'implicit', PAST, '20:45', '21:15')
  f.send(f.a, f.b)
  occupy(f.b, 'implicit', PAST, '21:00', '21:30')
  expectPending(f, incomingRoutine(f), /与其他事项冲突/u)
})

for (const invalid of ['structure', 'missing-task', 'peer-block']) {
  test(`past block ${invalid} validation remains intact even with an ended weekly overlap`, t => {
    const f = pair(t)
    occupy(f.a, 'block', PAST, '20:45', '21:15')
    if (invalid === 'peer-block') occupy(f.a, 'block', PAST, '22:00', '22:30')
    f.send(f.a, f.b)
    // The local writer rejects these invalid placements. Exercise an invalid
    // peer payload through the real receiver and SQLite rollback path instead.
    const op = structuredClone(incomingRoutine(f))
    const planner = op.after.changes.find(change => change.entity === 'planner').after
    if (invalid === 'structure') planner.blocks[0].end = '20:40'
    if (invalid === 'missing-task') planner.blocks[0].taskId = 'missing-task'
    if (invalid === 'peer-block') Object.assign(planner.blocks[1], { start: '21:00', end: '21:30' })
    expectPending(f, op, invalid === 'structure' ? /结束时刻/u : invalid === 'missing-task' ? /关联事项缺失/u : /已有其他任务安排/u)
  })
}

for (const mode of ['block', 'implicit']) for (const dated of ['override', 'rescheduled', 'holiday', 'day-event']) {
  test(`past ${mode} conflicts with a ${dated} remain pending after a weekly routine change`, t => {
    const f = pair(t)
    occupy(f.a, mode, PAST, '20:45', '21:15')
    f.send(f.a, f.b)
    // These dated facts are allowed to record an actual conflict locally;
    // synchronization must still validate the final combined projection.
    const source = routine({ id: 'dated-source', title: '单日事实', kind: dated === 'holiday' ? 'break' : 'class', weekdays: [4] })
    let datedAction
    if (dated === 'day-event') {
      datedAction = { type: 'save-day-event', event: { id: 'dated-event', title: '单日活动', date: PAST, start: '20:30', end: '21:30', location: '', items: [] } }
    } else {
      edit(f.a, { type: 'save-routine', routine: source })
      f.send(f.a, f.b)
      if (dated === 'override') datedAction = { type: 'set-day-template', date: PAST, sourceWeekday: 4 }
      if (dated === 'rescheduled') datedAction = { type: 'set-day-exception', date: PAST, kind: 'rescheduled', sourceWeekday: 4 }
      if (dated === 'holiday') {
        edit(f.a, { type: 'save-routine', routine: { ...source, weekdays: [0, 6] } })
        f.send(f.a, f.b)
        datedAction = { type: 'set-day-exception', date: PAST, kind: 'holiday' }
      }
    }
    f.a.transaction(() => {
      f.a.updateTask(f.control.id, { notes: '不能独立提交这条伴随修改' })
      edit(f.a, datedAction)
      edit(f.a, { type: 'save-routine', routine: routine() })
    })
    assert.equal(f.a.sync.outbox().length, 1)
    const op = f.a.sync.outbox()[0]
    assert.equal(op.after.changes.length, 2)
    expectPending(f, op, /课程、休息或固定活动/u)
  })
}

for (const mode of ['block', 'implicit']) {
  test(`a restored date uses the recurring timetable for past ${mode}, while cancelled dates remain empty`, t => {
    const f = pair(t)
    edit(f.a, { type: 'set-day-exception', date: PAST, kind: 'restored' })
    edit(f.a, { type: 'set-day-exception', date: FUTURE, kind: 'cancelled' })
    occupy(f.a, mode, PAST, '20:45', '21:15')
    occupy(f.a, mode, FUTURE, '20:45', '21:15')
    f.send(f.a, f.b)
    const before = snapshot(f.b)
    assert.equal(f.b.sync.receive(incomingRoutine(f)), 'applied')
    assert.deepEqual(f.b.getPlanner().dayExceptions, before.planner.dayExceptions)
    assert.deepEqual(f.b.getPlanner().blocks, before.planner.blocks)
  })

  test(`a restored date retains future ${mode} conflict checks`, t => {
    const f = pair(t)
    edit(f.b, { type: 'set-day-exception', date: FUTURE, kind: 'restored' })
    occupy(f.b, mode, FUTURE, '20:45', '21:15')
    expectPending(f, incomingRoutine(f), /课程、休息或固定活动/u)
  })
}

test('local midnight distinguishes ended Sunday history from future Monday occupancy', t => {
  const f = pair(t, '2026-10-12T00:05:00+08:00')
  occupy(f.a, 'block', '2026-10-11', '23:00', '23:59', { locked: true })
  f.send(f.a, f.b)
  const past = incomingRoutine(f, routine({ id: 'sunday-night', weekdays: [0], start: '23:00', end: '23:59' }))
  assert.equal(f.b.sync.receive(past), 'applied')
  f.a.sync.exported(past.operationId)
  occupy(f.b, 'block', TODAY, '00:10', '00:30', { locked: true })
  expectPending(f, incomingRoutine(f, routine({ weekdays: [1], start: '00:10', end: '00:30' })), /课程、休息或固定活动/u)
})

test('an overnight implicit task uses local Monday overlap end, not its later whole-task end', t => {
  const f = pair(t, '2026-10-12T00:05:00+08:00')
  const task = f.a.createTask({ title: '跨午夜开始的事项', startAt: at('2026-10-11', '23:50'), estimateMin: 60 })
  f.send(f.a, f.b)
  const op = incomingRoutine(f, routine({ weekdays: [1], start: '00:00', end: '00:05' }))
  assert.equal(f.b.sync.receive(op), 'applied')
  assert.equal(f.b.getTask(task.id).startAt, task.startAt)
  assert.equal(f.b.getTask(task.id).estimateMin, 60)
})

test('an unrelated weekly clock in a DST gap does not invalidate a historical explicit block', t => {
  const originalTZ = process.env.TZ
  process.env.TZ = 'America/New_York'
  t.after(() => { process.env.TZ = originalTZ })
  const f = pair(t, '2026-10-12T10:32:00-04:00')
  occupy(f.a, 'block', '2026-03-08', '09:00', '09:30', { locked: true })
  f.send(f.a, f.b)
  const before = snapshot(f.b)
  const op = incomingRoutine(f, routine({ weekdays: [0], start: '02:30', end: '03:30' }))
  assert.equal(f.b.sync.receive(op), 'applied')
  assert.deepEqual(f.b.getPlanner().blocks, before.planner.blocks)
})

test('ordinary save-block still rejects a historical periodic overlap after synchronization permits retained history', t => {
  const f = pair(t)
  occupy(f.a, 'block', PAST, '20:45', '21:15', { locked: true })
  f.send(f.a, f.b)
  assert.equal(f.b.sync.receive(incomingRoutine(f)), 'applied')
  const task = f.b.createTask({ title: '普通新增历史安排' }), before = snapshot(f.b)
  assert.throws(() => edit(f.b, { type: 'save-block', block: { id: 'ordinary-past', taskId: task.id, date: '2026-09-28', start: '20:45', end: '21:15', locked: false } }), /课程、休息或固定活动/u)
  assert.deepEqual(snapshot(f.b), before)
})

test('ordinary undo still validates a reintroduced historical block against the complete routine', t => {
  const f = pair(t)
  occupy(f.a, 'block', PAST, '20:45', '21:15')
  f.send(f.a, f.b)
  assert.equal(f.b.sync.receive(incomingRoutine(f)), 'applied')
  const state = f.b.getPlanner()
  const receipt = f.b.applyPlannerOperation({
    id: randomUUID(), requestId: randomUUID(), summary: '移除已保留的历史时段',
    actions: [{ type: 'delete-block', id: state.blocks[0].id }], expectedRevision: state.revision,
  })
  const before = snapshot(f.b)
  assert.throws(() => f.b.undoOperation(receipt.id), /课程、休息或固定活动/u)
  assert.deepEqual(snapshot(f.b), before)
  assert.equal(f.b.listOperations().find(row => row.id === receipt.id).undoneAt, null)
})
