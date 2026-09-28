import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'

process.env.TZ = 'Asia/Shanghai'
const LAST_WEEK = '2026-09-15'
const THIS_WEEK = '2026-09-22'
const WEEK_END = '2026-09-28'

/** Every case runs on an in-memory database with a frozen clock: the goal is
 * created one week before the pass under test, so no real user data, current
 * time or planner is ever read. */
const fixture = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  let at = new Date(`${LAST_WEEK}T09:00:00+08:00`)
  const now = () => at
  const companion = createCompanion({ db, now }), freeTime = createFreeTime({ db, now })
  return { db, companion, freeTime, advance: value => { at = new Date(value) } }
}
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const openThisWeek = f => f.advance(`${THIS_WEEK}T08:00:00+08:00`)
const snapshot = f => ({ companion: f.db.getCompanionState(), planner: f.db.getPlanner(), tasks: f.db.listTasks({ includeDeleted: true }), operations: f.db.listOperations(), daily: f.db.getPreference('free-time-daily') })
const datesOf = blocks => [...new Set(blocks.map(item => item.date))].sort()
const liveTask = task => task && !task.deletedAt && ['todo', 'doing'].includes(task.status)

/** Last week's goal owns one task and its sessions. The task then stops in the
 * requested way before this week's scheduling pass ever runs. */
const lastWeekGoal = (f, kind) => {
  f.companion.saveFreeTimeGoal({ title: `长期余时-${kind}`, minPerWeek: 2, sessionMin: 30, sessionMax: 30 })
  const first = f.freeTime.schedule({ date: LAST_WEEK })
  const goalId = first.goals[0].id, taskId = first.goals[0].taskId
  const blocks = structuredClone(f.db.getPlanner().blocks)
  assert.equal(blocks.length, 2, `${kind}：上周先排满两次`)
  if (kind === 'dropped') f.db.updateTask(taskId, { status: 'dropped' })
  else if (kind === 'done') f.db.updateTask(taskId, { status: 'done' })
  else if (kind === 'deleted') f.db.deleteTask(taskId)
  else if (kind === 'missing') {
    const value = f.db.getCompanionState()
    value.freeTimeGoals = value.freeTimeGoals.map(goal => ({ ...goal, taskId: 'ghost-task' }))
    f.db.saveCompanionState(value)
  }
  // Baseline after the user's own action: deleting a task removes its blocks,
  // the other three stops leave them alone.
  const kept = structuredClone(f.db.getPlanner().blocks)
  return { goalId, taskId, blocks, kept }
}

test('跨周自动续排：旧关联事项已停止时新建事项补满本周频率，重复 ensure 与 schedule 都不重复', t => {
  for (const kind of ['dropped', 'done', 'deleted', 'missing']) {
    const f = fixture(t)
    const { goalId, taskId, blocks: oldBlocks, kept } = lastWeekGoal(f, kind)
    openThisWeek(f)

    const daily = f.freeTime.ensureDaily()
    assert.equal(daily.ensured, true, kind)
    assert.equal(daily.date, THIS_WEEK, kind)
    assert.equal(daily.shortfalls.length, 0, kind)
    assert.equal(daily.addedSessions.length, 2, kind)

    const newTaskId = daily.goals[0].taskId
    assert.notEqual(newTaskId, taskId, kind)
    assert.equal(f.db.getTask(newTaskId).freeTimeGoalId, goalId, kind)
    assert.equal(liveTask(f.db.getTask(newTaskId)), true, kind)
    assert.ok(daily.addedSessions.every(block => block.taskId === newTaskId), kind)
    assert.deepEqual(datesOf(daily.sessions), datesOf(daily.addedSessions), kind)
    assert.equal(daily.sessions.length, 2, kind)
    assert.ok(daily.sessions.every(item => item.date >= THIS_WEEK && item.date <= WEEK_END), kind)
    assert.equal(daily.progress[0].schedulingStatus, 'active', kind)
    assert.equal(daily.progress[0].scheduledCount, 2, kind)
    assert.equal(daily.progress[0].remainingCount, 0, kind)

    // The stopped task and every block the user's own action left behind stay
    // exactly as they were; no old session is revived, edited or reused.
    const blocks = f.db.getPlanner().blocks
    assert.equal(kept.length, kind === 'deleted' ? 0 : 2, kind)
    for (const old of kept) assert.deepEqual(blocks.find(item => item.id === old.id), old, `${kind}：旧时段保留`)
    assert.ok(daily.addedSessions.every(block => !oldBlocks.some(old => old.id === block.id)), kind)
    if (kind === 'dropped') assert.equal(f.db.getTask(taskId).status, 'dropped', kind)
    if (kind === 'done') assert.equal(f.db.getTask(taskId).status, 'done', kind)
    if (kind === 'deleted') assert.ok(f.db.getTask(taskId).deletedAt, kind)

    // One pass per day: the same day never arranges the same goal twice.
    assert.equal(f.freeTime.ensureDaily().ensured, false, kind)
    const again = f.freeTime.schedule({ date: THIS_WEEK })
    assert.equal(again.operation, null, kind)
    assert.equal(again.addedSessions.length, 0, kind)
    assert.equal(f.db.listTasks({ includeDeleted: true }).length, 2, kind)
    assert.deepEqual(again.sessions, daily.sessions, kind)
  }
})

test('暂停、移除或来源撤回的长余时目标不会被新一天的补排复活', t => {
  // Paused: the goal keeps its task and history, but no new arrangement.
  const paused = fixture(t)
  const pausedGoal = lastWeekGoal(paused, 'active')
  paused.companion.updateFreeTimeGoal(pausedGoal.goalId, { status: 'paused', expectedVersion: paused.freeTime.state({ date: LAST_WEEK }).goals[0].version })
  openThisWeek(paused)
  const pausedDaily = paused.freeTime.ensureDaily()
  assert.equal(pausedDaily.ensured, true)
  assert.equal(pausedDaily.addedSessions.length, 0)
  assert.equal(pausedDaily.operation, null)
  assert.equal(pausedDaily.sessions.length, 0)
  assert.equal(pausedDaily.progress[0].schedulingStatus, 'paused')
  assert.equal(pausedDaily.progress[0].remainingCount, 0)
  assert.equal(paused.db.listTasks().length, 1)
  assert.equal(paused.db.getTask(pausedGoal.taskId).status, 'todo')
  assert.deepEqual(paused.db.getPlanner().blocks.map(item => item.id).sort(), pausedGoal.blocks.map(item => item.id).sort())

  // Removed: the goal and its future sessions are retired, never recreated.
  const removed = fixture(t)
  const removedGoal = lastWeekGoal(removed, 'active')
  removed.companion.updateFreeTimeGoal(removedGoal.goalId, { status: 'deleted', expectedVersion: removed.freeTime.state({ date: LAST_WEEK }).goals[0].version })
  assert.equal(removed.freeTime.state({ date: LAST_WEEK }).goals.length, 0)
  assert.equal(removed.db.getPlanner().blocks.length, 0)
  openThisWeek(removed)
  const removedDaily = removed.freeTime.ensureDaily()
  assert.equal(removedDaily.ensured, true)
  assert.equal(removedDaily.addedSessions.length, 0)
  assert.equal(removedDaily.operation, null)
  assert.equal(removedDaily.goals.length, 0)
  assert.equal(removed.db.getPlanner().blocks.length, 0)
  assert.equal(removed.db.listTasks().length, 1)
  assert.equal(removed.db.getTask(removedGoal.taskId).status, 'dropped')

  // Retracted source: the goal is not a durable target any more.
  const retracted = fixture(t)
  const conversation = retracted.db.getActiveConversation()
  const turn = retracted.db.beginTurn({ requestId: 'rollover-source', conversationId: conversation.id, text: '加入余时：数学复习', context: { timezone: 'Asia/Shanghai', page: 'home' } })
  retracted.companion.saveFreeTimeGoal({ title: '数学复习', evidence: '数学复习', minPerWeek: 2, sessionMin: 30, sessionMax: 30 }, { kind: 'conversation', messageId: turn.userMessageId })
  const shared = retracted.freeTime.schedule({ date: LAST_WEEK })
  retracted.db.finishTurn('rollover-source', { status: 'completed' })
  retracted.db.retractMessage(turn.userMessageId)
  assert.equal(retracted.freeTime.state({ date: LAST_WEEK }).goals.length, 0)
  const afterRetraction = retracted.db.getPlanner().blocks.map(item => item.id).sort()
  openThisWeek(retracted)
  const retractedDaily = retracted.freeTime.ensureDaily()
  assert.equal(retractedDaily.ensured, true)
  assert.equal(retractedDaily.addedSessions.length, 0)
  assert.equal(retractedDaily.operation, null)
  assert.equal(retractedDaily.goals.length, 0)
  assert.deepEqual(retracted.db.getPlanner().blocks.map(item => item.id).sort(), afterRetraction)
  assert.equal(retracted.db.listTasks({ includeDeleted: true }).length, 1)
  assert.equal(liveTask(retracted.db.getTask(shared.goals[0].taskId)), false)
})

test('本周没有真实空档时补排只报告缺口，不创建孤立事项也不写日程', t => {
  const f = fixture(t)
  const { taskId, blocks: oldBlocks } = lastWeekGoal(f, 'dropped')
  for (const routine of f.db.getPlanner().routines.filter(item => item.kind === 'available')) update(f.db, { type: 'delete-routine', id: routine.id })
  const tasksBefore = f.db.listTasks({ includeDeleted: true }).map(task => task.id)
  openThisWeek(f)

  const daily = f.freeTime.ensureDaily()
  assert.equal(daily.ensured, true)
  assert.equal(daily.addedSessions.length, 0)
  assert.equal(daily.operation, null)
  assert.equal(daily.sessions.length, 0)
  assert.equal(daily.shortfalls.length, 1)
  assert.equal(daily.shortfalls[0].required, 2)
  assert.equal(daily.shortfalls[0].scheduled, 0)
  assert.match(daily.shortfalls[0].reason, /完整学习空档/)
  assert.doesNotMatch(daily.shortfalls[0].reason, /恢复并安排/)

  assert.deepEqual(f.db.listTasks({ includeDeleted: true }).map(task => task.id), tasksBefore)
  assert.equal(f.db.listTasks().some(task => task.freeTimeGoalId === daily.goals[0].id && liveTask(task)), false)
  assert.equal(f.db.getTask(taskId).status, 'dropped')
  assert.deepEqual(f.db.getPlanner().blocks, oldBlocks)
  assert.equal(daily.progress[0].schedulingStatus, 'active')
  assert.equal(daily.progress[0].remainingCount, 2)
})

test('新一天补排在写入日程时失败会整体回滚，修好后重试仍能补满', t => {
  const f = fixture(t)
  const { taskId, blocks: oldBlocks } = lastWeekGoal(f, 'dropped')
  openThisWeek(f)
  const before = snapshot(f)

  const original = f.db.applyPlannerOperation
  f.db.applyPlannerOperation = () => { throw new Error('planner 写入失败') }
  try { assert.throws(() => f.freeTime.ensureDaily(), /planner 写入失败/) } finally { f.db.applyPlannerOperation = original }

  // No half-written task, block or daily marker survives the failure.
  assert.deepEqual(snapshot(f), before)
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getTask(taskId).status, 'dropped')
  assert.deepEqual(f.db.getPlanner().blocks, oldBlocks)

  // The day was never marked as arranged, so the next open tries again.
  const retried = f.freeTime.ensureDaily()
  assert.equal(retried.ensured, true)
  assert.equal(retried.addedSessions.length, 2)
  assert.equal(retried.progress[0].remainingCount, 0)
  assert.equal(f.db.listTasks().length, 2)
})
