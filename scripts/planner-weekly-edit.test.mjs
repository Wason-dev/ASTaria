import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { carryItems, dayCapacity, routinesForDay } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const thursday = '2026-09-24', sunday = '2026-09-20', nextSunday = '2026-09-27', monday = '2026-09-21'
const now = new Date('2026-09-19T12:00:00+08:00')
const routine = (patch = {}) => ({ id: 'morning', title: '数学', kind: 'class', weekdays: [4], start: '08:00', end: '08:45', location: '原教室', items: ['原课本'], enabled: true, ...patch })
const afternoon = [
  routine({ id: 'afternoon-1', title: '英语', weekdays: [2, 4], start: '13:30', end: '14:15', items: ['英语课本'] }),
  routine({ id: 'afternoon-2', title: '物理', start: '14:25', end: '15:10', items: ['物理实验服'] }),
  routine({ id: 'afternoon-3', title: '自习', kind: 'available', start: '15:20', end: '16:05', items: [] }),
  routine({ id: 'afternoon-4', title: '地理', start: '16:15', end: '17:00', items: ['地图册'] }),
  routine({ id: 'afternoon-5', title: '语文', start: '17:10', end: '17:55', items: ['语文课本'] }),
]
const replacements = [
  { routineId: 'afternoon-1', title: '物理', kind: 'class' },
  { routineId: 'afternoon-2', title: '英语', kind: 'class', location: '英语教室', items: ['英语课本'] },
  { routineId: 'afternoon-3', title: '地理', kind: 'class' },
  { routineId: 'afternoon-4', title: '语文', kind: 'class' },
  { routineId: 'afternoon-5', title: '自习', kind: 'available' },
]
const change = (patch = {}) => ({ type: 'edit-weekday', weekday: 4, replacements: structuredClone(replacements), syncDates: [], ...patch })
const invalid = error => error.status === 400
const conflict = error => error.status === 409
const operation = (db, actions, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '修正周四下午课表并同步本周日调课', actions, expectedRevision: db.getPlanner().revision, ...patch })
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() })
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  edit({ type: 'import-routines', routines: [routine(), ...afternoon,
    routine({ id: 'lunch', title: '午休', kind: 'break', weekdays: [1, 2, 3, 4, 5], start: '12:00', end: '13:00', items: ['水杯'] }),
    routine({ id: 'monday', title: '周一课程', weekdays: [1] }),
    routine({ id: 'disabled', title: '停课', enabled: false }),
  ] })
  return { db, edit }
}

test('five afternoon replacements preserve timings, morning, breaks, other weekdays and subject metadata', t => {
  const { db, edit } = fixture(t), before = db.getPlanner()
  const state = edit(change())
  assert.equal(state.revision, before.revision + 1)
  const slots = routinesForDay(state, thursday).filter(item => item.start >= '13:30' && item.start < '18:00')
  assert.deepEqual(slots.map(item => [item.title, item.kind, item.start, item.end]), replacements.map((item, index) => [item.title, item.kind, afternoon[index].start, afternoon[index].end]))
  assert.deepEqual(slots.map(item => [item.location, item.items]), [['', []], ['英语教室', ['英语课本']], ['', []], ['', []], ['', []]])
  for (const id of ['morning', 'lunch', 'monday', 'disabled', 'default-evening-study', 'default-weekend-availability']) {
    assert.deepEqual(state.routines.find(item => item.id === id), before.routines.find(item => item.id === id))
  }
  assert.deepEqual(state.routines.find(item => item.id === 'afternoon-1'), { ...afternoon[0], weekdays: [2] })
  const daySlots = state => routinesForDay(state, '2026-09-22').map(({ weekdays, ...item }) => item)
  assert.deepEqual(daySlots(state), daySlots(before))
  assert.deepEqual(carryItems(state, [], thursday).map(item => item.label).sort(), ['原课本', '水杯', '英语课本'].sort())
  assert.deepEqual(state.blocks, before.blocks)
  assert.deepEqual(state.dayOverrides, before.dayOverrides)
})

test('shared slot identifiers are deterministic and collision-safe; unchanged shared slots never split', t => {
  const { db, edit } = fixture(t)
  const base = `weekday-4-${createHash('sha256').update('afternoon-1').digest('hex').slice(0, 24)}`
  edit({ type: 'save-routine', routine: routine({ id: base, weekdays: [6] }) })
  const before = db.getPlanner(), beforeBackup = db.exportData()
  const unchanged = edit(change({ replacements: [{ routineId: 'afternoon-1', title: '英语', kind: 'class' }] }))
  assert.deepEqual(unchanged.routines, before.routines)
  const updated = edit(change({ replacements: [replacements[0]] }))
  const split = updated.routines.find(item => item.id === `${base}-1`)
  assert.ok(split)
  assert.deepEqual(split.weekdays, [4])
  assert.equal(updated.routines.find(item => item.id === base).title, '数学')
  const again = edit(change({ replacements: [{ routineId: split.id, title: '化学', kind: 'class' }] }))
  assert.equal(again.routines.length, updated.routines.length)
  assert.equal(again.routines.find(item => item.id === split.id).title, '化学')
  const freshDb = createDatabase(':memory:')
  t.after(() => freshDb.close())
  freshDb.importData(beforeBackup)
  assert.deepEqual(freshDb.updatePlanner(change({ replacements: [replacements[0]] }), freshDb.getPlanner().revision).routines, updated.routines)
})

test('repeated subject names keep separate periods and repeating the correction preserves slot identities', t => {
  const { db, edit } = fixture(t)
  const state = edit(change({ replacements: replacements.map(item => ({ routineId: item.routineId, title: '英语', kind: 'class' })) }))
  const slots = routinesForDay(state, thursday).filter(item => item.start >= '13:30' && item.start < '18:00')
  assert.equal(slots.length, 5)
  assert.equal(new Set(slots.map(item => item.id)).size, 5)
  assert.ok(slots.every(item => item.title === '英语'))
  const repeated = edit(change({ replacements: slots.map(item => ({ routineId: item.id, title: '英语', kind: 'class' })) }))
  assert.deepEqual(repeated.routines, state.routines)
  assert.deepEqual(db.getPlanner(), repeated)
})

test('weekly patch refreshes only explicitly selected matching snapshots after the complete batch', t => {
  const { db, edit } = fixture(t)
  for (const date of [sunday, nextSunday]) edit({ type: 'set-day-template', date, sourceWeekday: 4 })
  edit({ type: 'set-day-template', date: monday, sourceWeekday: 1 })
  const before = db.getPlanner(), state = edit(change({ syncDates: [sunday] }))
  assert.deepEqual(routinesForDay(state, sunday), routinesForDay(state, thursday))
  assert.deepEqual(state.dayOverrides[nextSunday], before.dayOverrides[nextSunday])
  assert.deepEqual(state.dayOverrides[monday], before.dayOverrides[monday])
  assert.deepEqual(state.dayOverrides[sunday].routines.find(item => item.id === 'lunch'), before.dayOverrides[sunday].routines.find(item => item.id === 'lunch'))
  const snapshot = structuredClone(state.dayOverrides[sunday])
  const physical = state.routines.find(item => item.title === '物理' && item.weekdays.includes(4))
  edit(change({ replacements: [{ routineId: physical.id, title: '化学', kind: 'class' }] }))
  assert.deepEqual(db.getPlanner().dayOverrides[sunday], snapshot)
})

test('manual saves refresh future linked snapshots while preserving historical and unrelated dates and tasks', t => {
  const { db, edit } = fixture(t), historical = '2026-09-13', today = '2026-09-19'
  for (const date of [historical, today, sunday, nextSunday]) edit({ type: 'set-day-template', date, sourceWeekday: 4 })
  edit({ type: 'set-day-template', date: monday, sourceWeekday: 1 })
  const task = db.createTask({ title: '周日既有安排' })
  const block = { id: 'manual-sync-conflict', taskId: task.id, date: sunday, start: '15:20', end: '15:50', locked: true }
  edit({ type: 'save-block', block })
  const before = db.getPlanner(), tasksBefore = db.listTasks()
  const state = edit({ type: 'save-routine', routine: { ...afternoon[2], title: '地理', kind: 'class', items: ['地图册'] } })
  for (const date of [today, sunday, nextSunday]) assert.deepEqual(routinesForDay(state, date), routinesForDay(state, thursday))
  assert.deepEqual(state.dayOverrides[historical], before.dayOverrides[historical])
  assert.deepEqual(state.dayOverrides[monday], before.dayOverrides[monday])
  assert.deepEqual(state.blocks, before.blocks)
  assert.deepEqual(db.listTasks(), tasksBefore)
  assert.deepEqual(dayCapacity(state, db.listTasks(), sunday, now).conflicts, [block.id])
  assert.equal(db.importData(db.exportData()).restored, true)
})

test('manual delete and import refresh removed weekdays as well as replacement weekdays', t => {
  const { db, edit } = fixture(t)
  for (const [date, sourceWeekday] of [[sunday, 4], [monday, 1]]) edit({ type: 'set-day-template', date, sourceWeekday })
  edit({ type: 'delete-routine', id: 'afternoon-2' })
  assert.ok(!db.getPlanner().dayOverrides[sunday].routines.some(item => item.id === 'afternoon-2'))
  const state = edit({ type: 'import-routines', routines: [
    { ...afternoon[3], weekdays: [1], title: '迁到周一' },
    { ...afternoon[4], title: '更新周四语文', items: ['新课本'] },
  ] })
  assert.deepEqual(routinesForDay(state, sunday), routinesForDay(state, thursday))
  assert.deepEqual(state.dayOverrides[monday].routines, state.routines.filter(item => item.enabled && item.weekdays.includes(1)))
  assert.ok(!state.dayOverrides[sunday].routines.some(item => item.id === 'afternoon-4'))
  assert.ok(state.dayOverrides[monday].routines.some(item => item.title === '迁到周一'))
})

test('manual corrections cannot invalidate a future override by removing its final class', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-day-template', date: monday, sourceWeekday: 1 })
  const before = db.getPlanner(), original = before.routines.find(item => item.id === 'monday')
  for (const action of [
    { type: 'delete-routine', id: original.id },
    { type: 'save-routine', routine: { ...original, enabled: false } },
    { type: 'import-routines', routines: [{ ...original, weekdays: [2] }] },
  ]) {
    assert.throws(() => edit(action), error => error.status === 409 && /先移除未来的单日调课/u.test(error.message))
    assert.deepEqual(db.getPlanner(), before)
  }
  edit({ type: 'remove-day-template', date: monday })
  assert.ok(!edit({ type: 'delete-routine', id: original.id }).routines.some(item => item.id === original.id))
})

test('real course corrections retain conflicting task blocks and later plans respect the complete timetable', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const first = db.createTask({ title: '原来已安排的作业' }), second = db.createTask({ title: '新任务' })
  const blocks = [thursday, sunday].map((date, index) => ({ id: `task-slot-${index}`, taskId: first.id, date, start: '15:20', end: '15:50', locked: true }))
  for (const block of blocks) edit({ type: 'save-block', block })
  const beforeTasks = db.listTasks(), before = db.getPlanner(), state = edit(change({ syncDates: [sunday] }))
  assert.deepEqual(state.blocks, before.blocks)
  assert.deepEqual(db.listTasks(), beforeTasks)
  for (const [index, date] of [thursday, sunday].entries()) {
    assert.deepEqual(dayCapacity(state, db.listTasks(), date, now).conflicts, [blocks[index].id])
    assert.throws(() => edit({ type: 'save-block', block: { id: randomUUID(), taskId: second.id, date, start: '15:50', end: '16:00', locked: false } }), conflict)
  }
  edit({ type: 'save-block', block: { id: randomUUID(), taskId: second.id, date: thursday, start: '17:10', end: '17:40', locked: false } })
})

test('malformed batches, unknown slots and mismatched snapshot sources leave state untouched', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-day-template', date: monday, sourceWeekday: 1 })
  const before = db.getPlanner()
  for (const action of [
    change({ weekday: -1 }), change({ weekday: 7 }), change({ weekday: '4' }), change({ weekday: 4.5 }),
    change({ replacements: [] }), change({ replacements: null }), change({ replacements: Array(33).fill(replacements[0]) }),
    change({ replacements: [replacements[0], replacements[0]] }),
    change({ replacements: [{ ...replacements[0], routineId: '' }] }),
    change({ replacements: [{ ...replacements[0], title: '' }] }),
    change({ replacements: [{ ...replacements[0], kind: 'other' }] }),
    change({ replacements: [{ ...replacements[0], start: '14:00' }] }),
    change({ replacements: [{ ...replacements[0], location: null }] }),
    change({ replacements: [{ ...replacements[0], items: ['x', 'x'] }] }),
    change({ replacements: [{ ...replacements[0], items: '课本' }] }),
    change({ syncDates: undefined }), change({ syncDates: [sunday, sunday] }),
    change({ syncDates: Array(32).fill(sunday) }), change({ syncDates: ['2026-02-30'] }),
    { ...change(), unexpected: true },
  ]) {
    assert.throws(() => edit(action), invalid)
    assert.deepEqual(db.getPlanner(), before)
  }
  for (const action of [
    change({ replacements: [...replacements, { routineId: 'missing', title: '未知', kind: 'class' }] }),
    change({ replacements: [{ routineId: 'monday', title: '周一不可改', kind: 'class' }] }),
    change({ replacements: [{ routineId: 'disabled', title: '停课不可改', kind: 'class' }] }),
    change({ syncDates: [sunday] }), change({ syncDates: [monday] }),
  ]) {
    assert.throws(() => edit(action), conflict)
    assert.deepEqual(db.getPlanner(), before)
  }
  edit({ type: 'check-item', date: sunday, key: 'water', checked: true })
  const latest = db.getPlanner()
  assert.throws(() => db.updatePlanner(change(), before.revision), conflict)
  assert.deepEqual(db.getPlanner(), latest)
})

test('syncing cannot erase all source classes and rolls back the whole edit', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const before = db.getPlanner()
  const clear = before.routines.filter(item => item.enabled && item.weekdays.includes(4) && item.kind === 'class').map(item => ({ routineId: item.id, title: '自习', kind: 'available' }))
  assert.throws(() => edit(change({ replacements: clear, syncDates: [sunday] })), conflict)
  assert.deepEqual(db.getPlanner(), before)
  assert.equal(edit(change({ replacements: clear })).routines.filter(item => item.enabled && item.weekdays.includes(4) && item.kind === 'class').length, 0)
})

test('one undo restores week and snapshots together; backup preserves schedules and invalidates old undo', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const before = db.getPlanner(), input = operation(db, [change({ syncDates: [sunday] })])
  const receipt = db.applyPlannerOperation(input), after = db.getPlanner()
  assert.equal(receipt.undoable, true)
  assert.deepEqual(receipt.requestedActions, input.actions)
  assert.deepEqual(db.applyPlannerOperation(input), receipt)
  assert.deepEqual(db.getPlanner(), after)
  const backup = db.exportData()
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 2 })
  assert.equal(db.importData(backup).restored, true)
  const restored = db.getPlanner()
  assert.deepEqual(restored, { ...after, revision: before.revision + 3 })
  assert.equal(db.listOperations().find(item => item.id === receipt.id).undoable, false)
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), restored)
})

test('later failed action rolls back the entire weekly operation and its receipt', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const task = db.createTask({ title: '不能排进新课程' }), before = db.getPlanner()
  assert.throws(() => db.applyPlannerOperation(operation(db, [change({ syncDates: [sunday] }), {
    type: 'save-block', block: { id: randomUUID(), taskId: task.id, date: sunday, start: '15:20', end: '15:50', locked: false },
  }])), conflict)
  assert.deepEqual(db.getPlanner(), before)
  assert.deepEqual(db.listOperations(), [])
})

test('a retracted weekly request stays blocked and later edits prevent stale undo', t => {
  const { db, edit } = fixture(t)
  const request = { requestId: randomUUID(), conversationId: 'main', text: '改周四下午课表', context: {} }
  db.beginTurn(request)
  const input = operation(db, [change()], { requestId: request.requestId })
  const receipt = db.applyPlannerOperation(input)
  db.retractRequest(request)
  const after = db.getPlanner()
  assert.throws(() => db.applyPlannerOperation(input), conflict)
  assert.deepEqual(db.getPlanner(), after)
  edit({ type: 'check-item', date: thursday, key: 'water', checked: true })
  const latest = db.getPlanner()
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), latest)
})
