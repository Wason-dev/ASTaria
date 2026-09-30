import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { currentPlanWeek, refreshPlanProgress } from '../server/freeTimePlan.mjs'
import { createXixi, contextUnits } from '../server/xixi.mjs'
import { freeTimeCompletionAction } from '../src/planner/completion.ts'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-22'
const outline = () => ['Java 变量、条件、循环、方法', '类、对象、构造方法、封装', 'Git、GitHub、WPILib', 'Subsystem、Command、Trigger', '模拟电机', '传感器', 'PID', '底盘驾驶', '自动程序', '机械基础', '真实机构', '机器人项目'].map((title, index) => ({ week: index + 1, title, details: '' }))
const longWeeks = () => Array.from({ length: 52 }, (_, index) => ({ week: index + 1,
  title: `第 ${index + 1} 周 ${'主题'.repeat(70)}`, details: `原有步骤 ${index + 1}：${'学习'.repeat(750)}` }))
const fixture = t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let at = new Date(`${DATE}T09:00:00+08:00`)
  const now = () => at, companion = createCompanion({ db, now }), freeTime = createFreeTime({ db, now })
  const goal = companion.saveFreeTimeGoal({ title: 'FRC 入门', minPerWeek: 2, sessionMin: 20, sessionMax: 30, planWeeks: outline() })
  return { db, companion, freeTime, goal, now, getGoal: () => db.getCompanionState().freeTimeGoals[0], advance: value => { at = new Date(value) } }
}
const call = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })

test('12 周大纲完整保存，日历仅安排当前阶段，重复排程无副作用，固定时段不移动', t => {
  const f = fixture(t), task = f.db.createTask({ title: '固定作业', estimateMin: 30 })
  const fixed = { id: 'fixed-homework', taskId: task.id, date: DATE, start: '18:00', end: '18:30', locked: true }
  f.db.updatePlanner({ type: 'save-block', block: fixed }, f.db.getPlanner().revision)
  const result = f.freeTime.schedule({ date: DATE }), goal = f.getGoal()
  assert.equal(goal.planWeeks.length, 12)
  assert.equal(result.addedSessions.length, 2)
  assert.equal(goal.planWeeks[0].sessionIds.length, 2)
  assert.equal(goal.planWeeks[0].requiredSessions, 2)
  assert.ok(goal.planWeeks.slice(1).every(week => !week.sessionIds))
  assert.equal(result.progress[0].planCurrentWeek, 1)
  assert.equal(f.db.listTasks().filter(item => item.freeTimeGoalId).length, 1)
  const before = f.db.getPlanner(), version = goal.version
  assert.equal(f.freeTime.schedule({ date: DATE }).operation, null)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.getGoal().version, version)
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === fixed.id), fixed)
})

test('已过日期不会完成阶段，跨周只补第一个未完成阶段', t => {
  const f = fixture(t), first = f.freeTime.schedule({ date: DATE })
  f.freeTime.completeSession({ sessionId: first.sessions[0].id })
  f.advance('2026-10-13T09:00:00+08:00')
  const later = f.freeTime.schedule()
  assert.equal(later.addedSessions.length, 1)
  assert.equal(currentPlanWeek(f.getGoal()).week, 1)
  assert.equal(later.progress[0].completedCount, 1)
  assert.equal(later.progress[0].planCompletedWeeks, 0)
  assert.ok(f.getGoal().planWeeks.slice(1).every(week => !week.sessionIds))
})

test('明确完成后推进，下次排程才安排新阶段；重试不重复，撤回不丢真实完成', t => {
  const f = fixture(t), first = f.freeTime.schedule({ date: DATE })
  const a = f.freeTime.completeSession({ sessionId: first.sessions[0].id })
  assert.equal(currentPlanWeek(f.getGoal()).week, 1)
  f.freeTime.completeSession({ sessionId: first.sessions[1].id })
  assert.equal(currentPlanWeek(f.getGoal()).week, 2)
  assert.equal(f.getGoal().planWeeks[1].sessionIds, undefined, '完成只推进，不隐式写入下一周安排')
  const nextSchedule = f.freeTime.schedule(), second = f.getGoal().planWeeks[1].sessionIds
  assert.equal(nextSchedule.addedSessions.length, 2)
  assert.equal(second.length, 2)
  const count = f.db.getPlanner().blocks.length, version = f.getGoal().version
  f.freeTime.completeSession({ sessionId: first.sessions[1].id, nextStep: '已完成 Java 入门' })
  assert.equal(f.db.getPlanner().blocks.length, count)
  assert.equal(f.getGoal().version, version)
  f.freeTime.completeSession({ sessionId: second[0] })
  f.freeTime.completeSession({ sessionId: second[1] })
  assert.equal(currentPlanWeek(f.getGoal()).week, 3)
  assert.equal(f.getGoal().planWeeks[2].sessionIds, undefined)
  f.freeTime.schedule()
  const third = structuredClone(f.getGoal().planWeeks[2].sessionIds)
  f.freeTime.reopenSession({ sessionId: a.sessionId, expectedCompletedAt: a.completedAt })
  assert.equal(currentPlanWeek(f.getGoal()).week, 1)
  assert.equal(f.getGoal().planWeeks[1].status, 'completed')
  assert.equal(f.getGoal().planWeeks[2].status, 'pending')
  assert.equal(f.getGoal().planWeeks[2].sessionIds, undefined, '回退清理下一阶段未开始且未固定的段')
  assert.ok(third.every(id => !f.db.getPlanner().blocks.some(block => block.id === id)))
  assert.match(f.db.getTask(f.getGoal().taskId).notes, /第 1 周/)
  assert.equal(f.freeTime.schedule().addedSessions.length, 0, '原时段仍有效，撤回后不再重复安排')
  f.freeTime.completeSession({ sessionId: a.sessionId })
  assert.equal(currentPlanWeek(f.getGoal()).week, 3)
  assert.equal(f.getGoal().planWeeks[2].sessionIds, undefined)
  assert.match(f.db.getTask(f.getGoal().taskId).notes, /第 3 周/)
})

test('撤销排程不算完成，当日不复活；明确重排后无重复阶段或学习段', t => {
  const f = fixture(t), result = f.freeTime.schedule()
  f.db.undoOperation(result.operation.id)
  assert.equal(f.freeTime.ensureDaily().ensured, false)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  const again = f.freeTime.schedule()
  assert.equal(again.addedSessions.length, 2)
  assert.equal(currentPlanWeek(f.getGoal()).week, 1)
  assert.equal(f.freeTime.schedule().addedSessions.length, 0)
  assert.equal(f.db.getCompanionState().freeTimeHistory.length, 0)
})

test('编辑保留阶段记录和冻结次数，不能删除已开始阶段或伪造进度', t => {
  const f = fixture(t), scheduled = f.freeTime.schedule()
  f.freeTime.completeSession({ sessionId: scheduled.sessions[0].id })
  const before = f.getGoal(), edited = outline(); edited[0].details = '写一个判断成绩和循环累计的 Java 程序'
  const saved = f.companion.updateFreeTimeGoal(before.id, { expectedVersion: before.version, planWeeks: edited, minPerWeek: 4 })
  assert.equal(saved.planWeeks[0].requiredSessions, 2)
  assert.deepEqual(saved.planWeeks[0].sessionIds, before.planWeeks[0].sessionIds)
  assert.match(f.db.getTask(saved.taskId).notes, /判断成绩/)
  assert.throws(() => f.companion.updateFreeTimeGoal(saved.id, { expectedVersion: saved.version, planWeeks: edited.slice(1) }), /已开始/)
  assert.throws(() => f.companion.updateFreeTimeGoal(saved.id, { expectedVersion: saved.version, planWeeks: [{ week: 1, title: '伪造', status: 'completed' }] }))
  assert.throws(() => f.companion.updateFreeTimeGoal(saved.id, { expectedVersion: saved.version, planWeeks: [{ week: 1, title: '重复' }, { week: 1, title: '重复' }] }), /重复/)
  assert.throws(() => f.companion.updateFreeTimeGoal(saved.id, { expectedVersion: saved.version, planWeeks: [{ week: 53, title: '越界' }] }), /1–52/)
  const stable = f.getGoal(), stableVersion = stable.version
  assert.equal(refreshPlanProgress(stable, f.db.getCompanionState().freeTimeHistory, '2026-10-10T00:00:00.000Z'), false)
  assert.equal(stable.version, stableVersion)
})

test('3000 字阶段详情完整保存，自动排程、编辑与推进只为事项生成受限摘要', t => {
  const f = fixture(t)
  const weeks = [{ week: 1, title: '第一阶段'.padEnd(160, '题'), details: '🧠'.repeat(1500) },
    { week: 2, title: '第二阶段'.padEnd(160, '题'), details: '下一阶段步骤'.padEnd(3000, '学') }]
  f.companion.updateFreeTimeGoal(f.goal.id, { expectedVersion: f.goal.version,
    title: '完整长期目标'.padEnd(160, '目'), targetNote: '阶段目标'.padEnd(1500, '标'), planWeeks: weeks })
  assert.equal(f.freeTime.ensureDaily().ensured, true)
  const goal = f.getGoal(), sessions = goal.planWeeks[0].sessionIds
  assert.equal(sessions.length, 2)
  const checkNotes = (expectedWeek, excerpt) => {
    const notes = f.db.getTask(goal.taskId).notes
    assert.ok(notes.length <= 2000)
    assert.ok(notes.includes(`第 ${expectedWeek} 周：${weeks[expectedWeek - 1].title}`))
    assert.ok(notes.includes(excerpt))
    assert.ok(notes.endsWith('…完整学习内容见余时计划。'))
    assert.doesNotThrow(() => encodeURIComponent(notes), '摘要不能截断 Unicode 代理对')
  }
  checkNotes(1, '🧠')
  assert.deepEqual(goal.planWeeks.map(week => week.details), weeks.map(week => week.details))
  weeks[0].details = '修订步骤'.padEnd(3000, '练')
  f.companion.updateFreeTimeGoal(goal.id, { expectedVersion: goal.version, planWeeks: weeks })
  checkNotes(1, '修订步骤')
  for (const sessionId of sessions) f.freeTime.completeSession({ sessionId })
  checkNotes(2, '下一阶段步骤')
  const completion = f.db.getCompanionState().freeTimeHistory.find(item => item.sessionId === sessions[0])
  f.freeTime.reopenSession({ sessionId: completion.sessionId, expectedCompletedAt: completion.completedAt })
  checkNotes(1, '修订步骤')
  assert.deepEqual(f.getGoal().planWeeks.map(week => week.details), weeks.map(week => week.details))
})

test('长期计划与真实完成记录备份恢复后仍只补当前阶段', t => {
  const f = fixture(t), result = f.freeTime.schedule()
  f.freeTime.completeSession({ sessionId: result.sessions[0].id })
  const before = f.getGoal(), backup = f.db.exportData()
  assert.equal(f.db.importData(backup).restored, true)
  assert.deepEqual(f.getGoal().planWeeks, before.planWeeks)
  assert.equal(f.freeTime.state().freeTimeProgress[0].completedCount, 1)
  assert.equal(f.freeTime.schedule().addedSessions.length, 0)
  assert.equal(f.db.importData(f.db.exportData()).restored, true)
})

test('完成全部阶段后停止补排', t => {
  const f = fixture(t)
  f.companion.updateFreeTimeGoal(f.goal.id, { expectedVersion: f.goal.version, minPerWeek: 1, planWeeks: outline().slice(0, 2) })
  f.freeTime.schedule()
  f.freeTime.completeSession({ sessionId: f.getGoal().planWeeks[0].sessionIds[0] })
  assert.equal(f.getGoal().planWeeks[1].sessionIds, undefined)
  f.freeTime.schedule()
  f.freeTime.completeSession({ sessionId: f.getGoal().planWeeks[1].sessionIds[0] })
  assert.equal(currentPlanWeek(f.getGoal()), undefined)
  assert.equal(f.freeTime.schedule().addedSessions.length, 0)
  assert.equal(f.freeTime.state().freeTimeProgress[0].planCompletedWeeks, 2)
  assert.equal(f.freeTime.state().freeTimeProgress[0].remainingCount, 0)
})

test('日程和专注的共享完成动作推进阶段，撤回保留固定/已开始/已完成段', t => {
  const f = fixture(t), first = f.freeTime.schedule()
  for (const session of first.sessions) {
    const action = freeTimeCompletionAction(f.db.getTask(session.taskId), f.freeTime.plannerState(), session.id)
    assert.equal(action.path, '/companion/free-time/complete')
    f.freeTime.completeSession(action.input)
  }
  assert.equal(currentPlanWeek(f.getGoal()).week, 2)
  const second = f.freeTime.schedule().addedSessions
  const locked = { ...second[0], locked: true }
  f.db.updatePlanner({ type: 'save-block', block: locked }, f.db.getPlanner().revision)
  const action = freeTimeCompletionAction(f.db.getTask(first.sessions[0].taskId), f.freeTime.plannerState(), first.sessions[0].id)
  assert.equal(action.path, '/companion/free-time/reopen')
  f.freeTime.reopenSession(action.input)
  assert.equal(currentPlanWeek(f.getGoal()).week, 1)
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === locked.id), locked)
  assert.ok(!f.db.getPlanner().blocks.some(block => block.id === second[1].id))
  assert.match(f.db.getTask(first.sessions[0].taskId).notes, /第 1 周/)
})

test('旧普通余时目标转为计划时保留旧安排且不把旧完成算入任何阶段', t => {
  const f = fixture(t)
  const ordinary = f.companion.saveFreeTimeGoal({ title: 'Java 学习', minPerWeek: 1 })
  const initial = f.freeTime.schedule(), session = initial.sessions.find(item => item.goalId === ordinary.id)
  f.freeTime.completeSession({ sessionId: session.id })
  const current = f.db.getCompanionState().freeTimeGoals.find(item => item.id === ordinary.id)
  f.companion.updateFreeTimeGoal(current.id, { expectedVersion: current.version, planWeeks: outline() })
  const scheduled = f.freeTime.schedule(), goal = f.db.getCompanionState().freeTimeGoals.find(item => item.id === ordinary.id)
  assert.equal(currentPlanWeek(goal).week, 1)
  assert.equal(goal.planWeeks[0].sessionIds.length, 1)
  assert.ok(!goal.planWeeks.some(week => week.sessionIds?.includes(session.id)))
  assert.ok(f.db.getPlanner().blocks.some(block => block.id === session.id))
  assert.equal(scheduled.progress.find(item => item.goalId === goal.id).completedCount, 0)
})

test('析熙细化入口拿到最新目标并把 details 写回原目标，不另建或抢跑未来阶段', async t => {
  const f = fixture(t)
  f.freeTime.schedule()
  const original = f.getGoal(), requests = []
  const model = createXixi({ db: f.db, now: f.now, complete: async payload => {
    requests.push(payload)
    if (payload.messages.some(message => message.role === 'tool')) return reply('本周内容已细化，时间安排继续保留。')
    const environmentMessage = payload.messages.find(message => message.content?.startsWith('当前环境与数据库资料'))
    const environment = JSON.parse(environmentMessage.content.slice(environmentMessage.content.indexOf('\n') + 1))
    const selected = environment.selectedFreeTimeGoal
    assert.equal(selected.id, original.id)
    assert.equal(selected.version, original.version)
    assert.equal(selected.planWeeks.length, 12)
    const weeks = selected.planWeeks.map(week => ({ week: week.week, title: week.title, details: week.week === 1 ? '1. 写变量与条件判断\n2. 用循环累计结果\n3. 提取并调用方法' : week.details }))
    assert.ok(payload.tools.find(tool => tool.function.name === 'save_free_time_goal').function.parameters.properties.planWeeks)
    return call('save_free_time_goal', { id: selected.id, expectedVersion: selected.version, title: selected.title, evidence: '请细化这个长期计划', planWeeks: weeks })
  } })
  const request = { requestId: randomUUID(), conversationId: 'long-plan', text: '请细化这个长期计划', context: { page: 'home', timezone: 'Asia/Shanghai', freeTimeGoalId: original.id } }
  const result = await model.chat(request)
  assert.equal(result.status, 'completed')
  assert.equal(f.db.getCompanionState().freeTimeGoals.length, 1)
  assert.match(f.getGoal().planWeeks[0].details, /循环累计/)
  assert.deepEqual(f.getGoal().source, original.source, '细化不更换目标来源，撤回新聊天不会删除原目标')
  assert.deepEqual(f.getGoal().planWeeks[0].sessionIds, original.planWeeks[0].sessionIds)
  assert.ok(f.getGoal().planWeeks.slice(1).every(week => !week.sessionIds))
  const version = f.getGoal().version
  await model.chat(request)
  assert.equal(f.getGoal().version, version)
  const turn = f.db.getTurn(request.requestId)
  const replay = f.companion.saveFreeTimeGoal({ id: original.id, expectedVersion: original.version, evidence: request.text },
    { kind: 'conversation', messageId: turn.userMessageId, actionId: f.getGoal().lastActionId })
  assert.equal(replay.version, version, '同一工具动作重放不会重复改写阶段')
  assert.equal(f.db.importData(f.db.exportData()).restored, true, '带目标上下文的聊天可备份')
  const blocks = f.db.getPlanner().blocks
  f.db.retractMessage(turn.userMessageId)
  assert.equal(f.getGoal().id, original.id, '撤回细化聊天不删除原本手工建立的目标')
  assert.deepEqual(f.db.getPlanner().blocks, blocks, '撤回细化聊天不删除原目标已有安排')
})

for (const status of ['active', 'paused']) test(`52 周 ${status} 长计划细化后可在默认预算内获得模型确认，未改的未来详情完整保留`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const companion = createCompanion({ db, now: () => new Date(`${DATE}T09:00:00+08:00`) })
  const weeks = longWeeks()
  const original = companion.saveFreeTimeGoal({ title: '完整长期计划', status, minPerWeek: 2, planWeeks: weeks })
  const calls = []
  const model = createXixi({ db, now: () => new Date(`${DATE}T09:00:00+08:00`), complete: async payload => {
    calls.push(payload)
    assert.ok(contextUnits(payload.messages) + contextUnits(payload.tools) <= 48_000)
    const receiptMessage = payload.messages.find(message => message.role === 'tool')
    if (receiptMessage) {
      const receipt = JSON.parse(receiptMessage.content)
      assert.equal(receipt.ok, true)
      assert.equal(receipt.goal.id, original.id)
      assert.equal(receipt.goal.version, db.getCompanionState().freeTimeGoals[0].version)
      assert.equal(receipt.goal.status, status)
      assert.equal(receipt.goal.planWeeksTotal, 52)
      assert.equal(receipt.goal.currentPlanWeek.details, '新的当前阶段步骤')
      assert.equal(receipt.goal.planWeeks, undefined)
      if (status === 'active') {
        assert.ok(receipt.goals.every(goal => goal.planWeeks === undefined))
        assert.equal(receipt.sessions.length, 2)
        assert.ok(receipt.operation.id)
      } else assert.equal(db.getPlanner().blocks.length, 0)
      return reply('当前阶段已细化。')
    }
    const environmentMessage = payload.messages.find(message => message.content?.startsWith('当前环境与数据库资料'))
    const environment = JSON.parse(environmentMessage.content.slice(environmentMessage.content.indexOf('\n') + 1))
    const selected = environment.selectedFreeTimeGoal
    assert.equal(selected.id, original.id)
    assert.equal(selected.version, original.version)
    assert.equal(selected.status, status)
    assert.equal(selected.minPerWeek, 2)
    assert.equal(selected.planWeeks.length, 52)
    assert.deepEqual(selected.planWeeks.map(week => week.title), weeks.map(week => week.title))
    assert.equal(selected.planWeeks[0].details, weeks[0].details)
    assert.ok(selected.planWeeks.slice(1).every(week => week.details === undefined && week.status === 'pending'))
    assert.equal(environment.companion.freeTimeGoals[0].currentPlanWeek.details, undefined)
    return call('save_free_time_goal', { id: selected.id, expectedVersion: selected.version,
      title: selected.title, evidence: '细化当前阶段', planWeeks: selected.planWeeks.map(week => ({
        week: week.week, title: week.title, ...(week.week === 1 ? { details: '新的当前阶段步骤' } : {}),
      })) })
  } })
  const result = await model.chat({ requestId: randomUUID(), conversationId: 'long-plan-budget', text: '细化当前阶段',
    context: { page: 'home', timezone: 'Asia/Shanghai', freeTimeGoalId: original.id } })
  assert.equal(result.status, 'completed')
  assert.equal(calls.length, 2)
  assert.equal(result.messages.at(-1).content, '当前阶段已细化。')
  const saved = db.getCompanionState().freeTimeGoals[0]
  assert.equal(saved.status, status)
  assert.equal(saved.planWeeks[0].details, '新的当前阶段步骤')
  assert.deepEqual(saved.planWeeks.slice(1).map(week => week.details), weeks.slice(1).map(week => week.details))
  assert.equal(db.getCompanionState().freeTimeGoals.length, 1)
})

test('52 周目标可先读完整大纲，再定向读取未来阶段全文并继续模型回复', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const weeks = longWeeks().map(week => ({ ...week, title: week.title.padEnd(160, '题'), details: week.details.padEnd(3000, '学') }))
  const companion = createCompanion({ db, now: () => new Date(`${DATE}T09:00:00+08:00`) })
  const goal = companion.saveFreeTimeGoal({ title: '完整长期计划', minPerWeek: 2, planWeeks: weeks })
  const calls = []
  const model = createXixi({ db, now: () => new Date(`${DATE}T09:00:00+08:00`), complete: async payload => {
    calls.push(payload)
    assert.ok(contextUnits(payload.messages) + contextUnits(payload.tools) <= 48_000)
    const receipts = payload.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
    if (!receipts.length) return call('read_free_time', { limit: 1 })
    if (receipts.length === 1) {
      const read = receipts[0]
      assert.equal(read.goals.length, 1)
      assert.equal(read.total, 1)
      assert.equal(read.nextOffset, null)
      assert.equal(read.goals[0].planWeeks.length, 52)
      assert.deepEqual(read.goals[0].planWeeks.map(week => week.title), weeks.map(week => week.title))
      assert.equal(read.goals[0].planWeeks[0].details, weeks[0].details)
      assert.ok(read.goals[0].planWeeks.slice(1).every(week => week.details === undefined && week.detailsOmitted === true))
      assert.ok(read.goals[0].planWeeks.slice(1).every(week => week.status === 'pending'))
      return call('read_free_time', { goalId: goal.id, planWeek: 52 })
    }
    assert.equal(receipts[1].goal.id, goal.id)
    assert.equal(receipts[1].goal.version, goal.version)
    assert.equal(receipts[1].planWeek.week, 52)
    assert.equal(receipts[1].planWeek.title, weeks[51].title)
    assert.equal(receipts[1].planWeek.details, weeks[51].details)
    assert.equal(receipts[1].planWeek.status, 'pending')
    assert.equal(receipts[1].planWeeksTotal, 52)
    return reply('已核对第 52 周的完整步骤。')
  } })
  const result = await model.chat({ requestId: randomUUID(), conversationId: 'long-plan-read', text: '读计划大纲，再核对第 52 周',
    context: { page: 'home', timezone: 'Asia/Shanghai', freeTimeGoalId: goal.id } })
  assert.equal(result.status, 'completed', JSON.stringify({ calls: calls.length, error: result.error }))
  assert.equal(calls.length, 3)
  assert.equal(result.messages.at(-1).content, '已核对第 52 周的完整步骤。')
  assert.deepEqual(db.getCompanionState().freeTimeGoals[0].planWeeks.map(week => week.details), weeks.map(week => week.details))
})

test('read_free_time 单周选择器校验配对、目标、周号及分页参数', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const companion = createCompanion({ db, now: () => new Date(`${DATE}T09:00:00+08:00`) })
  const goal = companion.saveFreeTimeGoal({ title: '一周计划', planWeeks: [{ week: 1, title: '基础', details: '完整步骤' }] })
  const cases = [
    [{ goalId: goal.id }, /同时提供goalId和planWeek/u],
    [{ planWeek: 1 }, /同时提供goalId和planWeek/u],
    [{ goalId: goal.id, planWeek: 1, offset: 0 }, /不使用offset或limit/u],
    [{ goalId: goal.id, planWeek: 0 }, /1–52/u],
    [{ goalId: 'missing', planWeek: 1 }, /已不存在/u],
    [{ goalId: goal.id, planWeek: 2 }, /没有该计划周/u],
  ]
  for (const [args, expected] of cases) {
    let round = 0
    const model = createXixi({ db, now: () => new Date(`${DATE}T09:00:00+08:00`), complete: async () =>
      round++ === 0 ? call('read_free_time', args) : reply('已记录读取错误。') })
    const result = await model.chat({ requestId: randomUUID(), conversationId: randomUUID(), text: '读取这一周',
      context: { page: 'home', timezone: 'Asia/Shanghai' } })
    assert.equal(result.status, 'completed')
    const receipt = JSON.parse(result.messages.find(message => message.role === 'tool').content)
    assert.equal(receipt.ok, false)
    assert.match(receipt.error, expected)
  }
})

test('schedule_free_time 对长计划只回传有界目标摘要，保留真实排程和模型确认', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const companion = createCompanion({ db, now: () => new Date(`${DATE}T09:00:00+08:00`) })
  const weeks = longWeeks().map(week => ({ ...week, title: week.title.padEnd(160, '题'), details: week.details.padEnd(3000, '学') }))
  const goal = companion.saveFreeTimeGoal({ title: '完整长期计划', minPerWeek: 2, planWeeks: weeks })
  const calls = []
  const model = createXixi({ db, now: () => new Date(`${DATE}T09:00:00+08:00`), complete: async payload => {
    calls.push(payload)
    assert.ok(contextUnits(payload.messages) + contextUnits(payload.tools) <= 48_000)
    const receiptMessage = payload.messages.find(message => message.role === 'tool')
    if (!receiptMessage) return call('schedule_free_time', { date: DATE })
    const receipt = JSON.parse(receiptMessage.content)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.goals[0].id, goal.id)
    assert.equal(receipt.goals[0].planWeeksTotal, 52)
    assert.equal(receipt.goals[0].planWeeks, undefined)
    assert.equal(receipt.sessions.length, 2)
    assert.ok(receipt.operation.id)
    return reply('本阶段的两段学习已安排。')
  } })
  const result = await model.chat({ requestId: randomUUID(), conversationId: 'long-plan-schedule', text: '安排本周余时学习',
    context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(result.status, 'completed')
  assert.equal(calls.length, 2)
  assert.equal(result.messages.at(-1).content, '本阶段的两段学习已安排。')
  assert.equal(db.getPlanner().blocks.length, 2)
  const saved = db.getCompanionState().freeTimeGoals[0]
  assert.equal(saved.planWeeks.length, 52)
  assert.deepEqual(saved.planWeeks.map(week => week.details), weeks.map(week => week.details))
  assert.ok(db.getTask(saved.taskId).notes.length <= 2000)
})
