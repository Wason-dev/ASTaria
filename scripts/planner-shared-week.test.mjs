import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'

process.env.TZ = 'Asia/Shanghai'
const FIRST = '2026-09-07', NEXT = '2026-09-14'
const routine = (id, weekCycle, weekAnchor = FIRST) => ({ id, title: id, kind: 'class', weekdays: [1],
  start: id === 'even' ? '10:00' : '08:00', end: id === 'even' ? '11:00' : '09:00',
  location: '', items: [], enabled: true, weekCycle, weekAnchor })
const fixture = t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  return { db, edit: action => db.updatePlanner(action, db.getPlanner().revision) }
}

test('shared first Monday unifies alternating routines without rewriting dated snapshots or task blocks', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'import-routines', routines: [routine('odd', 'odd'), routine('even', 'even', NEXT)] })
  edit({ type: 'set-day-template', date: FIRST, sourceWeekday: 1 })
  const task = db.createTask({ title: '作业' })
  edit({ type: 'save-block', block: { id: 'work', taskId: task.id, date: NEXT, start: '13:00', end: '13:30', locked: true } })
  const before = db.getPlanner()
  edit({ type: 'set-first-week-monday', date: NEXT })
  const after = db.getPlanner()
  assert.equal(after.firstWeekMonday, NEXT)
  assert.ok(after.routines.filter(item => item.weekCycle).every(item => item.weekAnchor === NEXT))
  assert.deepEqual(after.dayOverrides, before.dayOverrides)
  assert.deepEqual(after.blocks, before.blocks)
  assert.equal(after.revision, before.revision + 1)
  assert.throws(() => db.updatePlanner({ type: 'set-first-week-monday', date: FIRST }, before.revision), /其他窗口/u)
  assert.throws(() => edit({ type: 'set-first-week-monday', date: '2026-09-15' }), /周一/u)
})

test('new alternating routines use the shared anchor and cannot silently introduce a second one', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'set-first-week-monday', date: FIRST })
  edit({ type: 'save-routine', routine: { ...routine('odd', 'odd'), weekAnchor: undefined } })
  assert.equal(db.getPlanner().routines.find(item => item.id === 'odd').weekAnchor, FIRST)
  assert.throws(() => edit({ type: 'save-routine', routine: routine('even', 'even', NEXT) }), /统一/u)
  assert.throws(() => edit({ type: 'import-routines', routines: [routine('even', 'even', NEXT)] }), /统一/u)
})

test('changing shared anchor rejects a new class collision without moving or partially saving any task', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'save-routine', routine: routine('odd', 'odd') })
  const task = db.createTask({ title: '作业' })
  edit({ type: 'save-block', block: { id: 'work', taskId: task.id, date: NEXT, start: '08:00', end: '08:30', locked: false } })
  const before = db.getPlanner()
  assert.throws(() => edit({ type: 'set-first-week-monday', date: NEXT }), /已有任务时间重叠/u)
  assert.deepEqual(db.getPlanner(), before)
})

test('shared anchor roundtrips through backup and malformed or inconsistent anchor restores are rejected', t => {
  const { db, edit } = fixture(t), restored = fixture(t).db
  edit({ type: 'save-routine', routine: routine('odd', 'odd') })
  edit({ type: 'set-first-week-monday', date: FIRST })
  const backup = db.exportData()
  restored.importData(backup)
  assert.equal(restored.getPlanner().firstWeekMonday, FIRST)
  for (const date of ['2026-09-15', NEXT]) {
    const corrupted = structuredClone(backup)
    const row = corrupted.tables.state.find(item => item.key === 'planner-v1')
    row.value = JSON.stringify({ ...JSON.parse(row.value), firstWeekMonday: date })
    corrupted.checksum = createHash('sha256').update(JSON.stringify(corrupted.tables)).digest('hex')
    assert.throws(() => restored.importData(corrupted), error => error.status === 400)
    assert.equal(restored.getPlanner().firstWeekMonday, FIRST)
  }
  const missingAnchor = structuredClone(backup)
  const row = missingAnchor.tables.state.find(item => item.key === 'planner-v1')
  const state = JSON.parse(row.value)
  delete state.routines.find(item => item.id === 'odd').weekAnchor
  row.value = JSON.stringify(state)
  missingAnchor.checksum = createHash('sha256').update(JSON.stringify(missingAnchor.tables)).digest('hex')
  assert.throws(() => restored.importData(missingAnchor), /周一/u)
  assert.equal(restored.getPlanner().firstWeekMonday, FIRST)
})
