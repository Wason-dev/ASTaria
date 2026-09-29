import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { initialTaskSchedule } from '../server/autoSchedule.mjs'
import { defaultPlanner } from '../server/planner.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-18'
const NOW = new Date(`${DATE}T17:00:00+08:00`)
const sign = backup => ({ ...backup, checksum: createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex') })
const memory = t => { const db = createDatabase(':memory:'); t.after(() => db.close()); return db }
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const disk = t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-beta5-data-'))
  const filename = join(directory, 'test.sqlite')
  const db = createDatabase(filename), raw = new DatabaseSync(filename)
  raw.exec('PRAGMA busy_timeout = 0')
  t.after(() => { raw.close(); db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db, raw }
}
const routine = (id, start, end, patch = {}) => ({ id, title: '晚自习', kind: 'available', weekdays: [5],
  start, end, location: '', items: [], enabled: true, ...patch })
const schedule = (minutes, ranges, patch = {}, options = {}) => {
  const task = { id: 'work', title: '报告', status: 'todo', importance: 2, estimateMin: minutes,
    due: `${DATE}T22:00:00+08:00`, ...patch }
  const state = { ...defaultPlanner(), routines: ranges.map(([start, end], index) => routine(`slot-${index}`, start, end)) }
  return initialTaskSchedule({ state, allTasks: [task], tasks: [task], now: NOW,
    idForBlock: (_, index) => `plan-${index}`, bufferMin: 0, ...options })
}
const times = result => result.plans.map(({ date, start, end }) => ({ date, start, end }))

test('failed BEGIN IMMEDIATE does not enter callback or weaken the next outer transaction lock', t => {
  const { db, raw } = disk(t)
  let entered = false
  raw.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(() => db.transaction(() => { entered = true }), /locked/u)
    assert.equal(entered, false)
  } finally { raw.exec('ROLLBACK') }
  db.transaction(() => {
    // A leaked nesting depth starts with SAVEPOINT instead and permits this
    // competing write lock, despite already having entered our callback.
    assert.throws(() => raw.exec('BEGIN IMMEDIATE'), /locked/u)
    db.createTask({ title: '真实写入' })
  })
  assert.equal(db.listTasks().length, 1)
  assert.doesNotThrow(() => raw.exec('BEGIN IMMEDIATE; ROLLBACK'))
})

test('seed category and its generated marker roll back together when the marker write fails', t => {
  const { db, raw } = disk(t)
  raw.exec(`CREATE TRIGGER fail_marker BEFORE INSERT ON state
    WHEN NEW.key = 'generated-area:physics' BEGIN SELECT RAISE(ABORT, 'marker failed'); END`)
  assert.throws(() => db.createTask({ title: '物理', area: 'physics' }), /marker failed/u)
  assert.equal(raw.prepare("SELECT COUNT(*) count FROM areas WHERE id='physics'").get().count, 0)
  assert.equal(db.listTasks().length, 0)
})

test('creating a task rolls back a newly seeded category when the task insertion fails', t => {
  const { db, raw } = disk(t)
  raw.exec("CREATE TRIGGER fail_task BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'task failed'); END")
  assert.throws(() => db.createTask({ title: '物理', area: 'physics' }), /task failed/u)
  assert.equal(raw.prepare("SELECT COUNT(*) count FROM areas WHERE id='physics'").get().count, 0)
  assert.equal(raw.prepare("SELECT COUNT(*) count FROM state WHERE key='generated-area:physics'").get().count, 0)
})

test('renaming a seed category rolls back if clearing its migration marker fails', t => {
  const { db, raw } = disk(t)
  db.listAreas()
  raw.exec(`CREATE TRIGGER fail_marker_delete BEFORE DELETE ON state
    WHEN OLD.key = 'generated-area:physics' BEGIN SELECT RAISE(ABORT, 'marker delete failed'); END`)
  assert.throws(() => db.renameArea('physics', '新的物理'), /marker delete failed/u)
  assert.equal(db.listAreas().find(area => area.id === 'physics').name, '物理')
  assert.equal(raw.prepare("SELECT COUNT(*) count FROM state WHERE key='generated-area:physics'").get().count, 1)
})

test('backup preserves the daily free-time pass so restoring does not resurrect removed sessions', t => {
  const db = memory(t), now = () => NOW
  const companion = createCompanion({ db, now }), freeTime = createFreeTime({ db, now })
  companion.saveFreeTimeGoal({ title: 'Java', minPerWeek: 2, sessionMin: 30, sessionMax: 30 })
  freeTime.ensureDaily()
  assert.ok(db.getPlanner().blocks.length)
  for (const block of db.getPlanner().blocks) update(db, { type: 'delete-block', id: block.id })
  const marker = db.getPreference('free-time-daily'), backup = db.exportData()
  const restored = memory(t)
  restored.importData(backup)
  assert.deepEqual(restored.getPreference('free-time-daily'), marker)
  assert.equal(createFreeTime({ db: restored, now }).ensureDaily().ensured, false)
  assert.deepEqual(restored.getPlanner().blocks, [])
  const corrupted = structuredClone(backup)
  corrupted.tables.state.find(row => row.key === 'preferences:free-time-daily').value = JSON.stringify({ ...marker, date: 'not-a-day' })
  assert.throws(() => restored.importData(sign(corrupted)), error => error.status === 400)
  assert.deepEqual(restored.getPreference('free-time-daily'), marker)
})

test('duplicate open completion records are a validation error before any restore mutation', t => {
  const db = memory(t), task = db.createTask({ title: '报告' })
  db.updateTask(task.id, { status: 'done' })
  const before = db.exportData(), corrupted = structuredClone(before)
  corrupted.tables.task_completion_history.push({ ...corrupted.tables.task_completion_history[0], id: 2 })
  assert.throws(() => db.importData(sign(corrupted)), error => error.status === 400 && /同一任务.*完成记录/u.test(error.message))
  assert.deepEqual(db.exportData().tables, before.tables)
})

test('adjacent same-name preferred windows combine before checking occurrence duration', () => {
  const result = schedule(60, [['18:00', '18:50'], ['18:50', '19:40']], {
    occurrence: { seriesId: 'weekly', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: false },
  })
  assert.deepEqual(times(result), [{ date: DATE, start: '18:00', end: '19:00' }])
  assert.equal(result.unscheduled.length, 0)
  const separated = schedule(60, [['18:00', '18:50'], ['18:55', '19:40']], {
    occurrence: { seriesId: 'weekly', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: false },
  })
  assert.equal(separated.plans.length, 0, 'a real gap is never merged')
})

test('ordinary work prefers a later full slot over filling an early short gap', () => {
  assert.deepEqual(times(schedule(30, [['18:00', '18:25'], ['19:00', '19:30']])), [
    { date: DATE, start: '19:00', end: '19:30' },
  ])
})

test('split work reserves meaningful tails instead of 25 + 5 minute fragments', () => {
  const result = schedule(30, [['18:00', '18:25'], ['19:00', '19:20']])
  assert.deepEqual(times(result), [
    { date: DATE, start: '18:00', end: '18:15' }, { date: DATE, start: '19:00', end: '19:15' },
  ])
  assert.equal(result.allocations[0].scheduledMin, 30)
  assert.deepEqual(result.unscheduled, [])
  const shortfall = schedule(30, [['18:00', '18:25'], ['19:00', '19:05']])
  assert.equal(shortfall.allocations[0].scheduledMin, 15)
  assert.equal(shortfall.unscheduled[0].remainingMin, 15)
  assert.match(shortfall.unscheduled[0].reason, /每段至少 15 分钟/u)
})

test('explicit short tasks remain whole and requested days never silently split', () => {
  assert.deepEqual(times(schedule(5, [['18:00', '18:05']])), [{ date: DATE, start: '18:00', end: '18:05' }])
  assert.deepEqual(times(schedule(10, [['18:00', '18:05'], ['19:00', '19:05']])), [])
  assert.equal(schedule(30, [['18:00', '18:25'], ['19:00', '19:20']], {}, { dateByTask: new Map([['work', DATE]]) }).plans.length, 0)
})

test('complete-slot preference respects named windows, buffers and deadline', () => {
  const task = { id: 'work', title: '报告', estimateMin: 30, status: 'todo', importance: 2, due: `${DATE}T19:50:00+08:00` }
  const prior = { id: 'prior', title: '原安排', status: 'todo', estimateMin: 20, importance: 2 }
  const state = { ...defaultPlanner(), routines: [routine('dorm', '18:00', '20:00'), routine('other', '20:30', '22:00', { title: '宿舍' })],
    blocks: [{ id: 'prior-block', taskId: prior.id, date: DATE, start: '18:00', end: '18:20', locked: true }] }
  const result = initialTaskSchedule({ state, tasks: [task], allTasks: [task, prior], now: NOW,
    idForBlock: () => 'new', windowByTask: new Map([['work', '晚自习']]) })
  assert.deepEqual(times(result), [{ date: DATE, start: '18:30', end: '19:00' }])
  assert.equal(state.blocks.length, 1, 'pure scheduler does not mutate source planner')
})
