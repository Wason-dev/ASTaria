import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createLocalService } from '../server/index.mjs'

async function request(service, path, input) {
  const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
  req.url = `/api${path}`; req.method = input === undefined ? 'GET' : 'POST'
  req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
  req.headers = { host: '127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
  return new Promise(resolve => service.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }, () => resolve({ status: 404 })))
}

test('余时目标持久化偏好、并允许暂停而不创建任务或日程', t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const companion = createCompanion({ db, now: () => new Date('2026-09-22T09:00:00+08:00') })
  const goal = companion.saveFreeTimeGoal({ title: '数学复习', priority: 'high', minPerWeek: 4, sessionMin: 25, sessionMax: 50 })

  assert.equal(goal.title, '数学复习')
  assert.equal(goal.priority, 'high')
  assert.equal(goal.minPerWeek, 4)
  assert.equal(goal.sessionMin, 25)
  assert.equal(goal.sessionMax, 50)
  assert.equal(goal.status, 'active')
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.getPlanner().blocks.length, 0)
  assert.deepEqual(companion.listState().freeTimeGoals.map(item => item.id), [goal.id])

  const edited = companion.updateFreeTimeGoal(goal.id, { priority: 'normal', minPerWeek: 2, sessionMin: 20, sessionMax: 40, expectedVersion: goal.version })
  assert.equal(edited.version, 2)
  assert.equal(edited.priority, 'normal')
  assert.equal(edited.minPerWeek, 2)
  assert.throws(() => companion.updateFreeTimeGoal(goal.id, { minPerWeek: 3, expectedVersion: goal.version }), /其他窗口修改/)

  const paused = companion.updateFreeTimeGoal(goal.id, { status: 'paused', expectedVersion: edited.version })
  assert.equal(paused.status, 'paused')
  assert.equal(companion.listState().freeTimeGoals[0].status, 'paused')
  assert.throws(() => companion.updateFreeTimeGoal(goal.id, { sessionMax: 10, expectedVersion: paused.version }), /最长分钟数不能小于最短分钟数/)
})

test('余时目标拒绝不合理范围，并支持来源回放幂等', t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const companion = createCompanion({ db })
  assert.throws(() => companion.saveFreeTimeGoal({ title: '单词', sessionMin: 45, sessionMax: 20 }), /最长分钟数不能小于最短分钟数/)
  const source = { kind: 'user', actionId: 'free-time-goal-action-1' }
  const first = companion.saveFreeTimeGoal({ title: 'FRC 知识', minPerWeek: 1 }, source)
  const replay = companion.saveFreeTimeGoal({ title: 'FRC 知识（重复请求）', minPerWeek: 3 }, source)
  assert.equal(replay.id, first.id)
  assert.equal(companion.listState().freeTimeGoals.length, 1)
})

test('余时目标接口保存与更新，清除只移除选中的目标', async t => {
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw Error('No model call expected') } })
  t.after(() => service.close())
  const created = await request(service, '/companion/free-time-goal', { title: '背单词' })
  assert.equal(created.status, 200)
  const goal = created.value
  const second = await request(service, '/companion/free-time', { title: 'FRC' })
  assert.equal(second.status, 200)
  const updated = await request(service, '/companion/free-time-goal/update', { id: goal.id, priority: 'high', status: 'paused', expectedVersion: goal.version })
  assert.equal(updated.status, 200)
  assert.equal(updated.value.title, '背单词')
  assert.equal(updated.value.status, 'paused')
  const removed = await request(service, '/companion/free-time/update', { id: goal.id, status: 'deleted', expectedVersion: updated.value.version })
  assert.equal(removed.status, 200)
  assert.equal(removed.value.status, 'deleted')
  const state = (await request(service, '/companion')).value
  assert.deepEqual(state.freeTimeGoals.map(item => item.title), ['FRC'])
  assert.deepEqual(state.wishes, [])
  assert.deepEqual(db.listTasks(), [])
})

test('余时目标跟随备份恢复并刷新版本，非法范围不能进入备份', t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const companion = createCompanion({ db })
  const goal = companion.saveFreeTimeGoal({ title: '数学复习', minPerWeek: 3 })
  const backup = db.exportData()
  db.importData(backup)
  const restored = companion.listState().freeTimeGoals[0]
  assert.equal(restored.id, goal.id)
  assert.equal(restored.version, goal.version + 1)
  assert.throws(() => companion.updateFreeTimeGoal(goal.id, { status: 'paused', expectedVersion: goal.version }), /其他窗口修改/)
  const broken = structuredClone(backup)
  const row = broken.tables.state.find(item => item.key === 'companion-v1')
  const value = JSON.parse(row.value)
  value.freeTimeGoals[0].sessionMin = 50
  row.value = JSON.stringify(value)
  broken.checksum = createHash('sha256').update(JSON.stringify(broken.tables)).digest('hex')
  assert.throws(() => db.importData(broken), /余时目标时长范围无效/)
  assert.equal(companion.listState().freeTimeGoals[0].version, restored.version)
})

test('来源撤回会清除析熙添加的余时目标，旧记录可继续读取', t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  db.saveCompanionState({ handoffs: [], wishes: [], scenarios: [] })
  const companion = createCompanion({ db })
  assert.deepEqual(companion.listState().freeTimeGoals, [])
  const conversation = db.getActiveConversation()
  const turn = db.beginTurn({ requestId: 'goal-source', conversationId: conversation.id, text: '加入余时：数学复习', context: {} })
  companion.saveFreeTimeGoal({ title: '数学复习', evidence: '数学复习' }, { kind: 'conversation', messageId: turn.userMessageId })
  db.finishTurn('goal-source', { status: 'completed' })
  assert.equal(companion.listState().freeTimeGoals.length, 1)
  db.retractMessage(turn.userMessageId)
  assert.equal(companion.listState().freeTimeGoals.length, 0)
})
