import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay } from '../src/home/agenda.ts'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-22'

/** Every case runs on an in-memory database with a frozen clock: no real user
 * data, current time or planner is ever read. */
const fixture = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  let at = new Date(`${DATE}T09:00:00+08:00`)
  const now = () => at
  const companion = createCompanion({ db, now }), freeTime = createFreeTime({ db, now })
  return { db, companion, freeTime, advance: value => { at = new Date(value) } }
}
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const goalNow = (freeTime, date = DATE) => freeTime.state({ date }).goals[0]
const progressNow = (freeTime, date = DATE) => freeTime.state({ date }).freeTimeProgress[0]
// The caller resumes exactly what the UI last read: goal version and the
// updatedAt of the still-attached task, or null when no task is attached.
const resumeInput = (freeTime, db, date = DATE) => {
  const goal = goalNow(freeTime, date), task = goal.taskId ? db.getTask(goal.taskId) : null
  return { id: goal.id, expectedVersion: goal.version, expectedTaskUpdatedAt: task?.updatedAt ?? null, date }
}
const overlaps = (a, b) => a.date === b.date && a.start < b.end && b.start < a.end
const snapshot = f => ({ companion: f.db.getCompanionState(), planner: f.db.getPlanner(), tasks: f.db.listTasks({ includeDeleted: true }), operations: f.db.listOperations() })
const request = async (service, path, input) => {
  const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
  req.url = `/api${path}`; req.method = input === undefined ? 'GET' : 'POST'
  req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
  req.headers = { host: '127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
  return new Promise(resolve => service.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }, () => resolve({ status: 404 })))
}

test('关联事项放下后历史时段不再计入安排，自动排程与日内补排都不复活旧任务', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '数学复习', minPerWeek: 2, sessionMin: 30, sessionMax: 30 })
  const first = f.freeTime.schedule({ date: DATE })
  const taskId = first.goals[0].taskId
  const oldBlocks = structuredClone(f.db.getPlanner().blocks)
  assert.equal(oldBlocks.length, 2)
  f.db.updateTask(taskId, { status: 'dropped' })

  const state = f.freeTime.state({ date: DATE })
  assert.equal(state.freeTimeSessions.length, 0)
  const progress = state.freeTimeProgress[0]
  assert.equal(progress.schedulingStatus, 'dropped')
  assert.equal(progress.taskUpdatedAt, f.db.getTask(taskId).updatedAt)
  assert.equal(progress.scheduledCount, 0)
  assert.equal(progress.scheduledMin, 0)
  assert.equal(progress.remainingCount, 2)
  assert.deepEqual(f.db.getPlanner().blocks, oldBlocks)

  const automatic = f.freeTime.schedule({ date: DATE })
  assert.equal(automatic.addedSessions.length, 0)
  assert.equal(automatic.operation, null)
  assert.equal(automatic.sessions.length, 0)
  assert.equal(automatic.shortfalls.length, 1)
  assert.match(automatic.shortfalls[0].reason, /恢复并安排/)
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getTask(taskId).status, 'dropped')
  assert.deepEqual(f.db.getPlanner().blocks, oldBlocks)

  f.advance('2026-09-23T09:00:00+08:00')
  const daily = f.freeTime.ensureDaily()
  assert.equal(daily.ensured, true)
  assert.equal(daily.addedSessions.length, 0)
  assert.equal(daily.operation, null)
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getTask(taskId).status, 'dropped')
  assert.deepEqual(f.db.getPlanner().blocks, oldBlocks)
})

test('显式恢复新建任务与新日程，旧任务保持放下且旧时段不会被重新启用', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: 'FRC 机械', minPerWeek: 2, sessionMin: 30, sessionMax: 30 })
  const first = f.freeTime.schedule({ date: DATE })
  const oldTaskId = first.goals[0].taskId
  const oldBlocks = structuredClone(f.db.getPlanner().blocks)
  f.db.updateTask(oldTaskId, { status: 'dropped' })
  // A live arrangement now owns the old window. The planner accepts it because
  // a dropped task's history no longer occupies time.
  const manual = f.db.createTask({ title: '数学作业', estimateMin: 60 })
  update(f.db, { type: 'save-block', block: { id: 'manual-block', taskId: manual.id, date: oldBlocks[0].date, start: oldBlocks[0].start, end: oldBlocks[0].end, locked: true } })
  const blocker = structuredClone(f.db.getPlanner().blocks.find(item => item.id === 'manual-block'))

  const resumed = f.freeTime.resume(resumeInput(f.freeTime, f.db))
  const newTaskId = resumed.goals[0].taskId
  assert.notEqual(newTaskId, oldTaskId)
  assert.equal(resumed.goals[0].status, 'active')
  assert.equal(f.db.getTask(newTaskId).freeTimeGoalId, resumed.goals[0].id)
  assert.equal(f.db.getTask(oldTaskId).status, 'dropped')
  assert.equal(resumed.addedSessions.length, 2)
  assert.ok(resumed.addedSessions.every(block => block.taskId === newTaskId))

  const blocks = f.db.getPlanner().blocks
  assert.equal(blocks.length, 5)
  for (const old of oldBlocks) assert.deepEqual(blocks.find(item => item.id === old.id), old)
  assert.ok(resumed.addedSessions.every(block => !oldBlocks.some(old => old.id === block.id)))
  assert.deepEqual(blocks.find(item => item.id === 'manual-block'), blocker)
  for (const block of resumed.addedSessions) {
    assert.equal(overlaps(block, blocker), false)
    for (const other of resumed.addedSessions) if (other.id !== block.id) assert.equal(overlaps(block, other), false)
  }

  const after = f.freeTime.state({ date: DATE })
  assert.equal(after.freeTimeSessions.length, 2)
  assert.ok(after.freeTimeSessions.every(session => session.taskId === newTaskId))
  assert.equal(after.freeTimeProgress[0].schedulingStatus, 'active')
  assert.equal(after.freeTimeProgress[0].scheduledCount, 2)
  assert.equal(after.freeTimeProgress[0].remainingCount, 0)
})

test('暂停的目标恢复后继续沿用原来的关联事项，不重复建任务', t => {
  const f = fixture(t)
  const goal = f.companion.saveFreeTimeGoal({ title: '背单词', minPerWeek: 1, sessionMin: 20, sessionMax: 20 })
  const first = f.freeTime.schedule({ date: DATE })
  const taskId = first.goals[0].taskId, session = first.sessions[0]
  const paused = f.companion.updateFreeTimeGoal(goal.id, { status: 'paused', expectedVersion: first.goals[0].version })
  assert.equal(paused.status, 'paused')
  assert.equal(f.db.getTask(taskId).status, 'todo')
  assert.equal(progressNow(f.freeTime).schedulingStatus, 'paused')
  assert.equal(progressNow(f.freeTime).remainingCount, 0)

  const resumed = f.freeTime.resume(resumeInput(f.freeTime, f.db))
  assert.equal(resumed.goals[0].status, 'active')
  assert.equal(resumed.goals[0].taskId, taskId)
  assert.equal(f.db.getTask(taskId).freeTimeGoalId, goal.id)
  assert.equal(f.db.getTask(taskId).status, 'todo')
  assert.equal(f.db.listTasks({ includeDeleted: true }).length, 1)
  assert.equal(resumed.addedSessions.length, 0)
  assert.deepEqual(resumed.sessions.map(item => item.id), [session.id])
  const progress = progressNow(f.freeTime)
  assert.equal(progress.schedulingStatus, 'active')
  assert.equal(progress.taskUpdatedAt, f.db.getTask(taskId).updatedAt)
  assert.equal(progress.scheduledCount, 1)
  assert.equal(progress.remainingCount, 0)
})

test('恢复会解绑已经停止的关联事项：dropped、done、deleted 与 missing', t => {
  const cases = { dropped: 'dropped', done: 'done', deleted: 'missing', missing: 'missing' }
  for (const [kind, schedulingStatus] of Object.entries(cases)) {
    const f = fixture(t)
    f.companion.saveFreeTimeGoal({ title: `余时目标-${kind}`, minPerWeek: 1, sessionMin: 20, sessionMax: 20 })
    const first = f.freeTime.schedule({ date: DATE })
    const taskId = first.goals[0].taskId
    if (kind === 'dropped') f.db.updateTask(taskId, { status: 'dropped' })
    else if (kind === 'done') f.db.updateTask(taskId, { status: 'done' })
    else if (kind === 'deleted') f.db.deleteTask(taskId)
    else {
      const value = f.db.getCompanionState()
      value.freeTimeGoals = value.freeTimeGoals.map(goal => ({ ...goal, taskId: 'ghost-task' }))
      f.db.saveCompanionState(value)
    }
    assert.equal(progressNow(f.freeTime).schedulingStatus, schedulingStatus)
    const goal = goalNow(f.freeTime), task = f.db.getTask(goal.taskId)
    const resumed = f.freeTime.resume({ id: goal.id, expectedVersion: goal.version, expectedTaskUpdatedAt: task?.updatedAt ?? null, date: DATE })
    assert.notEqual(resumed.goals[0].taskId, taskId)
    assert.equal(f.db.getTask(resumed.goals[0].taskId).status, 'todo')
    assert.equal(f.db.listTasks({ includeDeleted: true }).length, 2)
    assert.equal(resumed.addedSessions.length, 1)
    if (kind === 'dropped') assert.equal(f.db.getTask(taskId).status, 'dropped')
    if (kind === 'done') assert.equal(f.db.getTask(taskId).status, 'done')
    if (kind === 'deleted') assert.ok(f.db.getTask(taskId).deletedAt)
  }
})

test('陈旧的目标版本或事项时间戳拒绝恢复，并且不写入任何状态', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: 'FRC', minPerWeek: 1, sessionMin: 20, sessionMax: 20 })
  const first = f.freeTime.schedule({ date: DATE })
  const taskId = first.goals[0].taskId
  const goal = goalNow(f.freeTime), task = f.db.getTask(taskId)
  const before = snapshot(f)

  assert.throws(() => f.freeTime.resume({ id: goal.id, expectedVersion: goal.version - 1, expectedTaskUpdatedAt: task.updatedAt, date: DATE }), /其他窗口修改/)
  assert.throws(() => f.freeTime.resume({ id: goal.id, expectedVersion: goal.version, expectedTaskUpdatedAt: '2020-01-01T00:00:00.000Z', date: DATE }), /关联事项已在其他窗口修改/)
  assert.throws(() => f.freeTime.resume({ id: goal.id, expectedTaskUpdatedAt: task.updatedAt, date: DATE }), /其他窗口修改/)
  assert.throws(() => f.freeTime.resume({ id: 'missing-goal', expectedVersion: 1, expectedTaskUpdatedAt: null, date: DATE }), /这个余时目标已不存在/)

  assert.deepEqual(snapshot(f), before)
  assert.equal(goalNow(f.freeTime).version, goal.version)
  assert.equal(goalNow(f.freeTime).taskId, taskId)
  assert.equal(goalNow(f.freeTime).status, 'active')
})

test('后续排程抛错时整个恢复事务回滚，不留新任务或半程安排', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '数学复习', minPerWeek: 2, sessionMin: 30, sessionMax: 30 })
  const first = f.freeTime.schedule({ date: DATE })
  const taskId = first.goals[0].taskId
  f.db.updateTask(taskId, { status: 'dropped' })
  const input = resumeInput(f.freeTime, f.db)
  const before = snapshot(f)

  assert.throws(() => f.freeTime.resume({ ...input, date: '2026-09-21' }), /余时安排从今天或未来开始/)
  assert.deepEqual(snapshot(f), before)

  // The user-visible failure mode is a schedule step that cannot write its
  // time blocks; the goal unbinding and the new task must roll back with it.
  const original = f.db.applyPlannerOperation
  f.db.applyPlannerOperation = () => { throw new Error('planner 写入失败') }
  try { assert.throws(() => f.freeTime.resume(input), /planner 写入失败/) } finally { f.db.applyPlannerOperation = original }

  assert.deepEqual(snapshot(f), before)
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(goalNow(f.freeTime).taskId, taskId)
  assert.equal(goalNow(f.freeTime).version, input.expectedVersion)
  assert.equal(f.db.getTask(taskId).status, 'dropped')
})

test('没有空档时恢复只保存目标，短缺如实报告且不创建孤立任务', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '数学复习', minPerWeek: 3, sessionMin: 30, sessionMax: 30 })
  const first = f.freeTime.schedule({ date: DATE })
  const taskId = first.goals[0].taskId
  assert.equal(first.sessions.length, 3)
  f.db.updateTask(taskId, { status: 'dropped' })
  for (const routine of f.db.getPlanner().routines.filter(item => item.kind === 'available')) update(f.db, { type: 'delete-routine', id: routine.id })

  const tasksBefore = f.db.listTasks({ includeDeleted: true }).map(task => task.id)
  const input = resumeInput(f.freeTime, f.db)
  const resumed = f.freeTime.resume(input)
  assert.equal(resumed.addedSessions.length, 0)
  assert.equal(resumed.operation, null)
  assert.equal(resumed.sessions.length, 0)
  assert.equal(resumed.goals[0].status, 'active')
  assert.equal(resumed.goals[0].version, input.expectedVersion + 1)
  assert.equal(resumed.goals[0].taskId, undefined)
  assert.equal(resumed.shortfalls.length, 1)
  assert.equal(resumed.shortfalls[0].required, 3)
  assert.equal(resumed.shortfalls[0].scheduled, 0)
  assert.match(resumed.shortfalls[0].reason, /完整学习空档/)

  assert.deepEqual(f.db.listTasks({ includeDeleted: true }).map(task => task.id), tasksBefore)
  assert.equal(f.db.listTasks().some(task => task.freeTimeGoalId === input.id && task.status !== 'dropped'), false)
  assert.equal(f.db.getTask(taskId).status, 'dropped')
  const progress = progressNow(f.freeTime)
  assert.equal(progress.schedulingStatus, 'active')
  assert.equal(progress.taskUpdatedAt, null)
  assert.equal(progress.remainingCount, 3)
})

test('HTTP /companion/free-time/resume 返回新增时段与公开操作回执', async t => {
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw Error('No model call expected') } })
  t.after(() => service.close())
  const date = localDay(new Date())
  const created = await request(service, '/companion/free-time', { title: '余时英语', minPerWeek: 1, sessionMin: 20, sessionMax: 20 })
  assert.equal(created.status, 200)
  const scheduled = await request(service, '/companion/free-time/schedule', { date })
  assert.equal(scheduled.status, 200)
  const taskId = scheduled.value.goals[0].taskId
  assert.ok(taskId)
  db.updateTask(taskId, { status: 'dropped' })
  const goal = (await request(service, '/companion')).value.freeTimeGoals[0]

  const stale = await request(service, '/companion/free-time/resume', { id: goal.id, expectedVersion: goal.version - 1, expectedTaskUpdatedAt: db.getTask(taskId).updatedAt, date })
  assert.equal(stale.status, 409)
  assert.match(stale.value.error, /其他窗口修改/)

  const resumed = await request(service, '/companion/free-time/resume', { id: goal.id, expectedVersion: goal.version, expectedTaskUpdatedAt: db.getTask(taskId).updatedAt, date })
  assert.equal(resumed.status, 200)
  assert.equal(resumed.value.addedSessions.length, 1)
  assert.notEqual(resumed.value.goals[0].taskId, taskId)
  assert.equal(resumed.value.addedSessions[0].taskId, resumed.value.goals[0].taskId)
  assert.equal(db.getTask(taskId).status, 'dropped')
  assert.equal(resumed.value.progress[0].schedulingStatus, 'active')
  assert.equal(resumed.value.progress[0].taskUpdatedAt, db.getTask(resumed.value.goals[0].taskId).updatedAt)

  const operation = resumed.value.operation
  assert.equal(typeof operation.id, 'string')
  assert.equal(operation.undoable, true)
  assert.equal(operation.undoneAt, null)
  assert.equal(operation.details.length, resumed.value.addedSessions.length)
  assert.equal(Object.hasOwn(operation, 'plannerBefore'), false)
  assert.equal(Object.hasOwn(operation, 'requestedActions'), false)
  assert.equal(db.listOperations().some(item => item.id === operation.id), true)

  const state = (await request(service, '/companion')).value
  assert.equal(state.freeTimeSessions.length, 1)
  assert.equal(state.freeTimeSessions[0].taskId, resumed.value.goals[0].taskId)
})
