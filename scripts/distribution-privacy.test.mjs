import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { SEED_AREAS } from '../src/domain/task.ts'
import { PERIODS, WEEKDAYS, weekSchedule, recommendTask } from '../src/domain/schedule.ts'

test('new installations have generic categories and no saved user records or course timetable', () => {
  const db = createDatabase(':memory:')
  try {
    assert.deepEqual(db.listAreas().map(({ id, name, defaultEnergy }) => ({ id, name, defaultEnergy })), SEED_AREAS)
    for (const table of ['tasks', 'events', 'memories', 'messages', 'turns', 'summaries']) {
      assert.deepEqual(db.exportData().tables[table], [], table)
    }
    assert.ok(db.getPlanner().routines.every(routine => routine.kind === 'available'))
    assert.deepEqual(db.getPlanner().blocks, [])
    assert.deepEqual(db.getPlanner().dayEvents, [])
    for (const day of WEEKDAYS) assert.deepEqual(weekSchedule(day), [])
    assert.equal(recommendTask([], '周一'), null)
  } finally { db.close() }
})

test('generic distribution defaults preserve saved categories, coursework and messages on reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-privacy-regression-'))
  const file = join(directory, 'test.sqlite')
  let db = createDatabase(file)
  try {
    const stamp = '2020-01-01T00:00:00.000Z'
    const area = { id: 'existing-personal-area', name: '用户自建分类', defaultEnergy: 'deep', createdAt: stamp, updatedAt: stamp, deletedAt: null }
    db.importLegacy({ areas: [area] })
    const task = db.createTask({ title: '已保存事项', area: area.id })
    const message = db.appendMessage({ conversationId: db.getActiveConversation().id, role: 'user', content: '已保存对话' })
    const routine = { id: 'existing-user-course', title: '自定义课程', kind: 'class', weekdays: [1], start: '10:00', end: '11:00', location: '', items: [], enabled: true }
    db.updatePlanner({ type: 'import-routines', routines: [routine] }, db.getPlanner().revision)
    const savedPlanner = db.getPlanner()
    db.close(); db = createDatabase(file)
    assert.deepEqual(db.listAreas().find(item => item.id === area.id), area)
    assert.deepEqual(db.getTask(task.id), task)
    assert.deepEqual(db.getMessage(message.id), message)
    assert.deepEqual(db.getPlanner(), savedPlanner)
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('distribution categories are generic and the legacy period template is empty', () => {
  assert.deepEqual(SEED_AREAS.map(area => area.name), ['数学', '语文', '英语', '物理', '工作', '生活', '项目'])
  assert.deepEqual(PERIODS, [])
})
