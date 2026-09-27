import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { initialTaskSchedule } from '../server/autoSchedule.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-22'
const fixture = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  let at = new Date(`${DATE}T09:00:00+08:00`)
  const now = () => at
  const companion = createCompanion({ db, now }), freeTime = createFreeTime({ db, now })
  return { db, companion, freeTime, advance: value => { at = new Date(value) } }
}
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)

test('最低频率分散到不同日期，每个目标只有一个真实任务，再次排程幂等', t => {
  const f = fixture(t)
  const goal = f.companion.saveFreeTimeGoal({ title: '数学复习', minPerWeek: 4, priority: 'high' })
  const result = f.freeTime.schedule({ date: DATE })
  assert.equal(result.sessions.length, 4)
  assert.equal(new Set(result.sessions.map(item => item.date)).size, 4)
  assert.ok(result.sessions.every(item => item.goalId === goal.id))
  assert.equal(new Set(result.sessions.map(item => item.taskId)).size, 1)
  assert.equal(f.db.listTasks()[0].freeTimeGoalId, goal.id)
  assert.equal(result.progress[0].remainingCount, 0)
  const revision = f.db.getPlanner().revision
  const again = f.freeTime.schedule({ date: DATE })
  assert.equal(again.operation, null)
  assert.equal(f.db.getPlanner().revision, revision)
  assert.equal(f.db.listTasks().length, 1)
  assert.deepEqual(again.sessions, result.sessions)
})

test('空档不足时不占固定课程或已有任务，连续学习间留出真实休息', t => {
  const f = fixture(t)
  update(f.db, { type: 'delete-routine', id: 'default-evening-study' })
  update(f.db, { type: 'delete-routine', id: 'default-weekend-availability' })
  update(f.db, { type: 'save-routine', routine: { id: 'one-day', title: '空课', kind: 'available', weekdays: [2], start: '12:00', end: '15:00', location: '', items: [], enabled: true } })
  update(f.db, { type: 'save-routine', routine: { id: 'class', title: '数学课', kind: 'class', weekdays: [2], start: '12:00', end: '12:30', location: '', items: [], enabled: true } })
  const task = f.db.createTask({ title: '明确作业', estimateMin: 30 })
  update(f.db, { type: 'save-block', block: { id: 'homework', taskId: task.id, date: DATE, start: '14:30', end: '15:00', locked: true } })
  f.companion.saveFreeTimeGoal({ title: '单词', minPerWeek: 3, sessionMin: 30, sessionMax: 30 })
  f.companion.saveFreeTimeGoal({ title: 'FRC', minPerWeek: 1, sessionMin: 30, sessionMax: 30 })
  const result = f.freeTime.schedule({ date: DATE })
  assert.equal(result.sessions.length, 2)
  assert.equal(result.sessions[0].start, '12:30')
  assert.equal(result.sessions[0].end, '13:00')
  assert.equal(result.sessions[1].start, '13:10')
  assert.equal(result.sessions[1].end, '13:40')
  assert.equal(result.shortfalls.length, 1)
  assert.equal(result.shortfalls[0].scheduled, 1)
  assert.equal(f.db.getPlanner().blocks.find(item => item.id === 'homework').locked, true)
  assert.ok(f.freeTime.state({ date: DATE }).freeTimeBreaks.some(item => item.start === '13:00' && item.end === '13:10'))
})

test('排程可撤销，日内ensure不会把撤销结果补回，暂停不新增', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '单词', minPerWeek: 2 })
  const first = f.freeTime.ensureDaily()
  assert.equal(first.ensured, true)
  f.db.undoOperation(first.operation.id)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.freeTime.ensureDaily().ensured, false)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  const goal = f.companion.listState().freeTimeGoals[0]
  f.companion.updateFreeTimeGoal(goal.id, { status: 'paused', expectedVersion: goal.version })
  assert.equal(f.freeTime.state({ date: DATE }).freeTimeProgress[0].remainingCount, 0)
  f.advance('2026-09-23T09:00:00+08:00')
  assert.equal(f.freeTime.ensureDaily().operation, null)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('完成只登记本次学习，过去计划不会自动算已完成；反馈和长期目标保留', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: 'FRC', minPerWeek: 2 })
  const result = f.freeTime.schedule({ date: DATE })
  const first = result.sessions[0]
  const record = f.freeTime.completeSession({ sessionId: first.id, feedback: 'stuck', nextStep: '继续检查CAN通信' })
  assert.equal(record.goalId, first.goalId)
  assert.equal(f.freeTime.completeSession({ sessionId: first.id }).sessionId, first.id)
  const followup = f.freeTime.completeSession({ sessionId: first.id, feedback: 'continue', nextStep: '下次从电机控制开始' })
  assert.equal(followup.completedAt, record.completedAt)
  assert.equal(followup.minutes, record.minutes)
  assert.equal(followup.feedback, 'continue')
  assert.equal(f.db.getTask(first.taskId).status, 'todo')
  const state = f.freeTime.state({ date: DATE })
  assert.equal(state.freeTimeProgress[0].completedCount, 1)
  assert.equal(state.freeTimeFeedback[0].nextStep, '下次从电机控制开始')
  f.advance('2026-09-29T09:00:00+08:00')
  const prior = f.freeTime.state({ date: DATE })
  assert.equal(prior.freeTimeProgress[0].completedCount, 1)
  assert.equal(prior.freeTimeProgress[0].remainingCount, 1)
})

test('阶段目标影响频次和单次时长，迁入原牵挂是原子且可重试的授权', t => {
  const f = fixture(t)
  const wish = f.companion.saveWish({ content: '数学复习', evidence: '我想复习数学' })
  const goal = f.companion.saveFreeTimeGoal({ fromWishId: wish.id, expectedWishVersion: wish.version, title: wish.content, targetDate: '2026-09-28', targetNote: '月考前复习函数' })
  const replay = f.companion.saveFreeTimeGoal({ fromWishId: wish.id, expectedWishVersion: wish.version, title: wish.content })
  assert.equal(replay.id, goal.id)
  assert.equal(f.companion.listState().wishes[0].status, 'paused')
  const result = f.freeTime.schedule({ date: DATE })
  assert.equal(result.sessions.length, 4)
  assert.ok(result.sessions.every(item => Number(item.end.slice(3)) - Number(item.start.slice(3)) === 40))
  assert.ok(result.sessions.every(item => item.date <= goal.targetDate))
})

test('移除目标取消未开始安排且不留待办孤儿，锁定安排保持用户控制', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: 'FRC', minPerWeek: 2 })
  const result = f.freeTime.schedule({ date: DATE }), goal = result.goals[0]
  f.companion.updateFreeTimeGoal(goal.id, { status: 'deleted', expectedVersion: goal.version })
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.getTask(goal.taskId).status, 'dropped')
  f.companion.saveFreeTimeGoal({ title: '阅读', minPerWeek: 1 })
  const second = f.freeTime.schedule({ date: DATE }), protectedSession = second.sessions[0], protectedGoal = second.goals[0]
  update(f.db, { type: 'save-block', block: { id: protectedSession.id, taskId: protectedSession.taskId, date: protectedSession.date, start: protectedSession.start, end: protectedSession.end, locked: true } })
  f.companion.updateFreeTimeGoal(protectedGoal.id, { status: 'deleted', expectedVersion: protectedGoal.version })
  assert.equal(f.db.getPlanner().blocks.length, 1)
  assert.equal(f.db.getPlanner().blocks[0].locked, true)
  assert.equal(f.db.getTask(protectedSession.taskId).freeTimeGoalId, undefined)
})

test('非五分钟偏好仍守住上限，短于最低量的手工改块不算完成频率', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '单词', minPerWeek: 2, sessionMin: 22, sessionMax: 23 })
  const first = f.freeTime.schedule({ date: DATE })
  const length = block => Number(block.end.slice(0, 2)) * 60 + Number(block.end.slice(3)) - Number(block.start.slice(0, 2)) * 60 - Number(block.start.slice(3))
  assert.ok(first.sessions.every(item => length(item) >= 22 && length(item) <= 23))
  for (const session of first.sessions) update(f.db, { type: 'save-block', block: { id: session.id, taskId: session.taskId, date: session.date, start: '18:00', end: '18:01', locked: false } })
  const before = f.freeTime.state({ date: DATE })
  assert.equal(before.freeTimeProgress[0].remainingCount, 2)
  assert.equal(before.freeTimeProgress[0].shortSessionCount, 2)
  const second = f.freeTime.schedule({ date: DATE })
  assert.equal(second.sessions.length, 4)
  assert.equal(new Set(second.sessions.map(item => item.date)).size, 4)
  assert.equal(second.progress[0].remainingCount, 0)
})

test('普通推演保留余时每次安排，不将长期目标压成一次任务', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '数学复习', minPerWeek: 3 })
  const schedule = f.freeTime.schedule({ date: DATE })
  const preview = f.companion.previewScenario({ date: DATE, days: 7, mode: 'rebalance' })
  assert.equal(preview.removedBlockIds.length, 0)
  assert.equal(preview.plans.length, 0)
  assert.ok(preview.warnings.some(item => item.includes('余时目标')))
  assert.throws(() => f.companion.previewDecision({ date: DATE, taskId: schedule.goals[0].taskId, strategy: 'today', recurrence: 'once' }), /余时长期目标/)
})

test('排程及反馈备份恢复保持目标关联与完成次数，来源撤回清理后续安排', t => {
  const f = fixture(t)
  f.advance('2027-09-22T09:00:00+08:00')
  const date = '2027-09-22'
  const conversation = f.db.getActiveConversation()
  const turn = f.db.beginTurn({ requestId: 'schedule-source', conversationId: conversation.id, text: '加入余时：数学复习', context: { timezone: 'Asia/Shanghai', page: 'home' } })
  f.companion.saveFreeTimeGoal({ title: '数学复习', evidence: '数学复习', minPerWeek: 2 }, { kind: 'conversation', messageId: turn.userMessageId })
  const result = f.freeTime.schedule({ date }, { requestId: 'schedule-source', actionId: 'schedule-source-action' })
  f.db.finishTurn('schedule-source', { status: 'completed' })
  f.freeTime.completeSession({ sessionId: result.sessions[0].id, nextStep: '函数应用题' })
  f.db.importData(f.db.exportData())
  assert.equal(f.freeTime.state({ date }).freeTimeProgress[0].completedCount, 1)
  assert.equal(f.db.getTask(result.goals[0].taskId).freeTimeGoalId, result.goals[0].id)
  f.db.retractMessage(turn.userMessageId)
  assert.equal(f.freeTime.state({ date }).goals.length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.getTask(result.goals[0].taskId).status, 'dropped')
})

test('普通自动排程不补排已撤销的余时学习，余时频率只由自身调度', t => {
  const f = fixture(t)
  f.companion.saveFreeTimeGoal({ title: '单词', minPerWeek: 2 })
  const result = f.freeTime.schedule({ date: DATE })
  f.db.undoOperation(result.operation.id)
  const task = f.db.getTask(result.goals[0].taskId)
  const generic = initialTaskSchedule({ state: f.db.getPlanner(), allTasks: f.db.listTasks(), tasks: [task], now: new Date(`${DATE}T09:00:00+08:00`), idForBlock: () => 'unexpected' })
  assert.deepEqual(generic.plans, [])
  assert.deepEqual(generic.allocations, [])
})
