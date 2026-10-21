import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'
import { horizonDraft } from '../src/xixi/horizonOrder.ts'
import { horizonDeadlineConflicts, rebaseHorizonDraft } from '../src/xixi/horizonDeadline.ts'
import { moveOrbitGroup } from '../src/xixi/orbitGroups.ts'

process.env.TZ = 'Asia/Shanghai'
const today = '2026-10-19', tomorrow = '2026-10-20'
function fixture(t) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const routine of db.getPlanner().routines) act({ type: 'delete-routine', id: routine.id })
  act({ type: 'save-routine', routine: { id: 'available', title: '可用时间', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  const target = db.createTask({ title: '相同标题', due: today })
  const other = db.createTask({ title: '相同标题', due: '2026-10-21' })
  for (const [id, task, start, end] of [['a', target, '14:00', '14:30'], ['b', target, '15:00', '15:30'], ['c', other, '16:00', '16:30']]) {
    act({ type: 'save-block', block: { id, taskId: task.id, date: today, start, end, locked: false } })
  }
  const complete = async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"changes":[]}' } }] })
  const service = createHorizonOrder({ db, now: () => new Date(`${today}T10:00:00+08:00`), complete })
  const snap = service.list()
  const group = snap.groups.find(group => group.tasks.some(task => task.id === 'a'))
  const draft = moveOrbitGroup(snap.groups, group.id, 1, 0)
  return { db, target, other, service, snap, draft }
}

test('DDL quick edit deduplicates by real task ID, keeping distinct tasks with identical titles', t => {
  const f = fixture(t)
  const conflicts = horizonDeadlineConflicts(f.snap, f.draft)
  assert.deepEqual(conflicts, [{ taskId: f.target.id, title: '相同标题', due: today, targetDate: tomorrow }])
  assert.deepEqual(horizonDeadlineConflicts(f.snap, f.snap.groups), [])
  const cleared = { ...f.snap, items: f.snap.items.map(item => ({ ...item, due: undefined })) }
  assert.deepEqual(horizonDeadlineConflicts(cleared, f.draft), [])
})

test('saving DDL preserves a moved draft, changes no placement, and completion validates and saves the same blocks', async t => {
  const f = fixture(t), placements = structuredClone(f.db.getPlanner().blocks)
  const oldRequest = { date: today, groups: horizonDraft(f.draft), expectedRevision: f.snap.revision, snapshotKey: f.snap.snapshotKey, requestId: randomUUID() }
  await assert.rejects(f.service.apply(oldRequest), /截止时间 DDL/)
  f.db.updateTask(f.target.id, { due: tomorrow }, f.target.updatedAt)
  assert.deepEqual(f.db.getPlanner().blocks, placements, 'DDL alone never moves sessions')
  await assert.rejects(f.service.apply({ ...oldRequest, requestId: randomUUID() }), /已有变化/)
  const next = f.service.list(), rebased = rebaseHorizonDraft(f.snap, next, f.draft)
  assert.deepEqual(horizonDraft(rebased), horizonDraft(f.draft))
  assert.deepEqual(horizonDeadlineConflicts(next, rebased), [])
  await f.service.apply({ date: today, groups: horizonDraft(rebased), expectedRevision: next.revision, snapshotKey: next.snapshotKey, requestId: randomUUID() })
  assert.equal(f.db.getTask(f.target.id).due, tomorrow)
  assert.equal(f.db.getTask(f.other.id).due, '2026-10-21')
  const blocks = f.db.getPlanner().blocks
  assert.equal(blocks.length, placements.length)
  assert.ok(blocks.filter(block => block.taskId === f.target.id).every(block => block.date === tomorrow))
})

test('rebasing refreshes item metadata and refuses missing, fixed, duplicate or changed-day drafts', t => {
  const f = fixture(t)
  const next = structuredClone(f.snap)
  for (const group of next.groups) for (const task of group.tasks) task.minutes = 45
  const rebased = rebaseHorizonDraft(f.snap, next, f.draft)
  assert.ok(rebased.flatMap(group => group.tasks).every(task => task.minutes === 45))
  next.groups[0].tasks.pop()
  assert.equal(rebaseHorizonDraft(f.snap, next, f.draft), null)
  assert.equal(rebaseHorizonDraft(f.snap, { ...f.snap, date: tomorrow }, f.draft), null)
  assert.equal(rebaseHorizonDraft(f.snap, f.snap, [...f.draft, f.draft[0]]), null)
})
