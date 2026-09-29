/**
 * End-to-end contract for the shared free-time completion history.
 *
 * The planner read projection (`completedFreeTimeSessions`), the companion
 * free-time state and the stored completion history must describe the same
 * completions: finishing one session of a two-day goal marks exactly that
 * session, reopening removes exactly that record, a stale stamp can never
 * withdraw a newer completion, and nothing that is not a live free-time
 * session may become a completion. Every case runs against a real local
 * service (HTTP middleware over an in-memory SQLite database) with a model
 * call that always fails: no network, keychain, user data or real planner.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay } from '../src/home/agenda.ts'

process.env.TZ = 'Asia/Shanghai'

const fixture = t => {
  const db = createDatabase(':memory:')
  const companion = createCompanion({ db })
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw new Error('No model call expected') } })
  t.after(() => service.close())
  // The service builds its own clock-backed free-time module, so API cases use
  // the real calendar day exactly like the reference recovery fixture does.
  return { db, companion, service, date: localDay(new Date()) }
}

const request = async (service, path, input) => {
  const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
  req.url = `/api${path}`; req.method = input === undefined ? 'GET' : 'POST'
  req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
  req.headers = { host: '127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
  return new Promise(resolve => service.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }, () => resolve({ status: 404 })))
}

const ok = (response, label) => {
  assert.equal(response.status, 200, `${label}: ${response.value?.error ?? ''}`)
  return response.value
}
const planner = (f, action) => action === undefined
  ? request(f.service, '/planner').then(response => ok(response, 'GET /planner'))
  : request(f.service, '/planner', { expectedRevision: f.db.getPlanner().revision, action }).then(response => ok(response, 'POST /planner'))
const companion = f => request(f.service, `/companion?date=${f.date}&days=7`).then(response => ok(response, 'GET /companion'))
const complete = (f, sessionId, extra = {}) => request(f.service, '/companion/free-time/complete', { sessionId, ...extra })
const reopen = (f, sessionId, expectedCompletedAt) => request(f.service, '/companion/free-time/reopen', { sessionId, expectedCompletedAt })
/** The raw history the projection is derived from; absent until the first write. */
const history = f => f.db.getCompanionState().freeTimeHistory ?? []

/** A default-routine window for a plain, non-goal block on the first day of `date`'s week. */
const plainSlot = date => {
  const value = new Date(`${date}T12:00:00`)
  return value.getDay() >= 1 && value.getDay() <= 5
    ? { date: localDay(value), start: '18:00', end: '18:30' }
    : { date: localDay(value), start: '09:00', end: '09:30' }
}
const saveBlock = (f, taskId, id, slot) => planner(f, { type: 'save-block', block: { id, taskId, date: slot.date, start: slot.start, end: slot.end, locked: false } })

/** Two sessions on two different days that share one real task. */
const arrange = async (f, extra = {}) => {
  ok(await request(f.service, '/companion/free-time', { title: '数学复习', evidence: '我想复习数学', minPerWeek: 2, sessionMin: 30, sessionMax: 30, ...extra }), '创建余时目标')
  const scheduled = ok(await request(f.service, '/companion/free-time/schedule', { date: f.date }), '排程')
  assert.equal(scheduled.sessions.length, 2, '最低两次频率落在两段')
  assert.equal(new Set(scheduled.sessions.map(item => item.date)).size, 2, '两段落在两天')
  assert.equal(new Set(scheduled.sessions.map(item => item.taskId)).size, 1, '同一关联事项')
  assert.ok(scheduled.sessions.every(item => item.completed === false))
  return scheduled
}

test('完成一段后投影与余时状态一致，任务仍待办且其它段未完成', async t => {
  const f = fixture(t)
  const scheduled = await arrange(f)
  const [first, second] = scheduled.sessions
  const revision = f.db.getPlanner().revision, blocks = structuredClone(f.db.getPlanner().blocks)

  const completion = ok(await complete(f, first.id, { feedback: 'smooth', nextStep: '下一步做函数题' }), '完成一段')
  assert.equal(completion.sessionId, first.id)
  assert.equal(completion.goalId, first.goalId)
  assert.equal(completion.minutes, 30)
  assert.match(completion.completedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

  const rows = history(f)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].sessionId, first.id)

  // The projection is derived from the same history the companion state reads.
  const projection = await planner(f)
  assert.deepEqual(projection.completedFreeTimeSessions, { [first.id]: completion.completedAt })
  assert.equal(projection.completedFreeTimeSessions[first.id], rows[0].completedAt)

  const state = await companion(f)
  assert.deepEqual(state.freeTimeSessions.map(item => [item.id, item.completed]), [[first.id, true], [second.id, false]])
  assert.deepEqual(Object.keys(projection.completedFreeTimeSessions), state.freeTimeSessions.filter(item => item.completed).map(item => item.id))
  const progress = state.freeTimeProgress[0]
  assert.equal(progress.completedCount, 1)
  assert.equal(progress.completedMin, 30)
  assert.equal(progress.scheduledCount, 2)
  assert.equal(progress.schedulingStatus, 'active')
  assert.equal(state.freeTimeGoals[0].status, 'active')
  assert.equal(state.freeTimeFeedback[0].sessionId, first.id)

  // Completing a session never touches the task, its goal or the planner.
  const task = f.db.getTask(first.taskId)
  assert.equal(task.status, 'todo')
  assert.equal(task.freeTimeGoalId, first.goalId)
  assert.deepEqual(f.db.getPlanner().blocks, blocks)
  assert.equal(f.db.getPlanner().revision, revision)
})

test('重复完成幂等，GET 与 POST planner 都保留投影，读取不改版本或历史', async t => {
  const f = fixture(t)
  const scheduled = await arrange(f)
  const first = scheduled.sessions[0]
  const record = ok(await complete(f, first.id, { feedback: 'stuck', nextStep: '继续检查CAN通信' }), '首次完成')

  const again = ok(await complete(f, first.id, { feedback: 'continue', nextStep: '从电机控制开始' }), '重复完成')
  assert.equal(again.sessionId, first.id)
  assert.equal(again.completedAt, record.completedAt, '重复完成保留原始完成时刻')
  assert.equal(again.minutes, record.minutes)
  assert.equal(again.feedback, 'continue')
  assert.equal(again.nextStep, '从电机控制开始')
  assert.equal(history(f).length, 1, '重复完成不追加历史')

  const read = await planner(f)
  assert.deepEqual(read.completedFreeTimeSessions, { [first.id]: record.completedAt })
  const revision = f.db.getPlanner().revision
  const written = await planner(f, { type: 'check-item', date: f.date, key: 'free-time-sync', checked: true })
  assert.equal(written.revision, revision + 1, '真实 planner 写入推进版本')
  assert.deepEqual(written.completedFreeTimeSessions, read.completedFreeTimeSessions, 'POST planner 也返回投影')
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, read.completedFreeTimeSessions)

  const before = {
    revision: f.db.getPlanner().revision, blocks: structuredClone(f.db.getPlanner().blocks),
    history: structuredClone(history(f)), companion: structuredClone(f.db.getCompanionState()), operations: f.db.listOperations().length,
  }
  await planner(f); await companion(f); await planner(f)
  assert.equal(f.db.getPlanner().revision, before.revision, '读取不推进 planner 版本')
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.deepEqual(history(f), before.history, '读取不写完成历史')
  assert.deepEqual(f.db.getCompanionState(), before.companion)
  assert.equal(f.db.listOperations().length, before.operations)
})

test('撤回只移除指定完成记录，保留其它段、任务与目标，重复撤回幂等', async t => {
  const f = fixture(t)
  const scheduled = await arrange(f)
  const [first, second] = scheduled.sessions
  const one = ok(await complete(f, first.id), '完成第一段')
  const two = ok(await complete(f, second.id), '完成第二段')
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, { [first.id]: one.completedAt, [second.id]: two.completedAt })

  const goalBefore = (await companion(f)).freeTimeGoals[0]
  const blocksBefore = structuredClone(f.db.getPlanner().blocks)

  const withdrawn = await reopen(f, first.id, one.completedAt)
  assert.equal(withdrawn.status, 200)
  assert.deepEqual(withdrawn.value, { sessionId: first.id, completed: false })

  assert.deepEqual((await planner(f)).completedFreeTimeSessions, { [second.id]: two.completedAt }, '只移除指定段')
  assert.deepEqual(history(f).map(item => item.sessionId), [second.id])
  assert.deepEqual(f.db.getPlanner().blocks, blocksBefore, '时块保持不变')
  const state = await companion(f)
  assert.deepEqual(state.freeTimeSessions.map(item => [item.id, item.completed]), [[first.id, false], [second.id, true]])
  assert.equal(state.freeTimeProgress[0].completedCount, 1)
  assert.equal(state.freeTimeGoals[0].status, 'active')
  assert.equal(state.freeTimeGoals[0].id, goalBefore.id)
  assert.equal(state.freeTimeGoals[0].version, goalBefore.version, '撤回不改目标版本')
  assert.equal(state.freeTimeGoals[0].taskId, goalBefore.taskId)
  assert.equal(f.db.getTask(goalBefore.taskId).status, 'todo')
  assert.equal(f.db.getTask(goalBefore.taskId).freeTimeGoalId, goalBefore.id)

  const repeated = await reopen(f, first.id, one.completedAt)
  assert.equal(repeated.status, 200, '已经撤回的段再次撤回仍然成功')
  assert.deepEqual(repeated.value, { sessionId: first.id, completed: false })
  assert.deepEqual(history(f).map(item => item.sessionId), [second.id])
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, { [second.id]: two.completedAt })

  assert.equal((await reopen(f, second.id, two.completedAt)).status, 200)
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, {}, '全部撤回后投影为空')
  assert.deepEqual(history(f), [])
})

test('过期的 completedAt 不能撤回重新完成的新记录', async t => {
  const f = fixture(t)
  const scheduled = await arrange(f)
  const first = scheduled.sessions[0]
  const initial = ok(await complete(f, first.id), '首次完成')
  assert.equal((await reopen(f, first.id, initial.completedAt)).status, 200)

  const refreshed = ok(await complete(f, first.id), '重新完成')
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, { [first.id]: refreshed.completedAt })

  const stale = await reopen(f, first.id, '2000-01-01T00:00:00.000Z')
  assert.equal(stale.status, 409, '旧时刻不能撤回新记录')
  assert.match(stale.value.error, /重新读取/)
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, { [first.id]: refreshed.completedAt }, '失败撤回不改动记录')
  assert.deepEqual(history(f).map(item => item.sessionId), [first.id])

  assert.equal((await reopen(f, first.id, refreshed.completedAt)).status, 200, '当前时刻仍可撤回')
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, {})
})

test('缺段与不相干普通任务都不会变成余时完成记录', async t => {
  const f = fixture(t)
  assert.equal((await complete(f, 'no-such-session')).status, 404)
  assert.equal((await reopen(f, 'no-such-session', '2000-01-01T00:00:00.000Z')).status, 404)

  const task = ok(await request(f.service, '/tasks/create', { title: '普通事项', estimateMin: 30 }), '创建普通事项')
  await saveBlock(f, task.id, 'plain-block', plainSlot(f.date))
  assert.equal((await complete(f, 'plain-block')).status, 404, '普通任务的时块不是余时段')
  assert.equal((await reopen(f, 'plain-block', '2000-01-01T00:00:00.000Z')).status, 404)

  assert.deepEqual(history(f), [])
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, {})
})

test('来源撤回后完成记录、余时状态与投影一起消失，且不能再次完成', async t => {
  const f = fixture(t)
  const conversation = f.db.getActiveConversation()
  const turn = f.db.beginTurn({ requestId: 'free-time-source', conversationId: conversation.id, text: '加入余时：数学复习', context: { timezone: 'Asia/Shanghai', page: 'home' } })
  // The goal's evidence must be a contiguous quote of the source user message.
  const goal = f.companion.saveFreeTimeGoal({ title: '数学复习', evidence: '数学复习', minPerWeek: 1, sessionMin: 30, sessionMax: 30 }, { kind: 'conversation', messageId: turn.userMessageId })
  const scheduled = ok(await request(f.service, '/companion/free-time/schedule', { date: f.date }), '排程')
  assert.equal(scheduled.sessions.length, 1)
  const session = scheduled.sessions[0]

  const record = ok(await complete(f, session.id), '完成余时段')
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, { [session.id]: record.completedAt })

  f.db.finishTurn('free-time-source', { status: 'completed' })
  ok(await request(f.service, `/messages/${encodeURIComponent(turn.userMessageId)}/retract`, {}), '撤回来源')
  assert.equal((await companion(f)).freeTimeGoals.some(item => item.id === goal.id), false)
  assert.equal(f.db.getPlanner().blocks.some(item => item.id === session.id), false)
  assert.equal(history(f).some(item => item.sessionId === session.id), false)
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, {}, '失效来源不再出现在投影里')
  assert.equal((await complete(f, session.id)).status, 404, '撤回后不能重新变成完成记录')
})

test('普通任务标记完成不会伪造余时历史或投影', async t => {
  const f = fixture(t)
  const task = ok(await request(f.service, '/tasks/create', { title: '普通事项', estimateMin: 30 }), '创建普通事项')
  await saveBlock(f, task.id, 'plain-block', plainSlot(f.date))
  const scheduled = await arrange(f)
  assert.equal(scheduled.sessions.length, 2)

  const before = structuredClone(history(f))
  ok(await request(f.service, '/tasks/update', { id: task.id, patch: { status: 'done' }, expectedUpdatedAt: f.db.getTask(task.id).updatedAt }), '完成普通任务')
  assert.equal(f.db.getTask(task.id).status, 'done')
  assert.deepEqual(history(f), before, '普通任务完成不写余时历史')
  assert.deepEqual((await planner(f)).completedFreeTimeSessions, {})
  const state = await companion(f)
  assert.ok(state.freeTimeSessions.every(item => item.completed === false))
  assert.equal(state.freeTimeProgress[0].completedCount, 0)
  assert.equal(state.freeTimeProgress[0].scheduledCount, 2, '余时段仍由自己的确认记录决定')
})


test('专注中安排被移动后旧快照不能完成该段，重新读取后可完成', async t => {
  const f = fixture(t), scheduled = await arrange(f), first = scheduled.sessions[0]
  const block = f.db.getPlanner().blocks.find(item => item.id === first.id)
  const expectedSession = Object.fromEntries(['taskId', 'date', 'start', 'end'].map(key => [key, block[key]]))
  const stale = await complete(f, first.id, { expectedSession: { ...expectedSession, date: '2001-01-01' } })
  assert.equal(stale.status, 409)
  assert.deepEqual(history(f), [])
  ok(await complete(f, first.id, { expectedSession }), '读取匹配的时段后完成')
  assert.equal(history(f).length, 1)
})
