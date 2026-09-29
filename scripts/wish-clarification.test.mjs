import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createXixi } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const now = () => new Date('2026-09-29T08:00:00+08:00')
const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const receipt = request => JSON.parse(request.messages.findLast(m => m.role === 'tool').content)
function fixture(t) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const companion = createCompanion({ db, now }), replies = [], requests = []
  const wish = companion.saveWish({ content: '学摄影', evidence: '想学摄影', items: ['相机'], expiresAt: '2026-10-10T20:00:00+08:00' })
  const xixi = createXixi({ db, now, complete: async request => {
    requests.push(request)
    const response = replies.shift()
    assert.ok(response, 'unexpected model request')
    return typeof response === 'function' ? response(request) : response
  } })
  const input = (text, wishId = wish.id) => ({ requestId: randomUUID(), conversationId: 'main', text, context: { page: 'home', timezone: 'Asia/Shanghai', wishId } })
  return { db, companion, wish, xixi, replies, requests, input }
}

test('clarification asks in the existing conversation without scheduling, then updates the same wish', async t => {
  const f = fixture(t), planner = f.db.getPlanner()
  f.replies.push(request => {
    assert.match(JSON.stringify(request.messages), /selectedWish/)
    assert.match(JSON.stringify(request.messages), /学摄影/)
    return answer('你更想拍什么？')
  })
  await f.xixi.chat(f.input('想把这份心愿聊清楚，还没决定安排时间'))
  assert.equal(f.db.getCompanionState().wishes.length, 1)
  assert.equal(f.db.getCompanionState().wishes[0].version, 1)
  assert.deepEqual(f.db.listTasks(), [])
  assert.deepEqual(f.db.getPlanner(), planner)

  const evidence = '想拍好家人的照片，先试一次窗边人像'
  f.replies.push(call('remember_wish', { id: f.wish.id, expectedVersion: 1, content: f.wish.content, evidence,
    clarification: { motivation: '拍好家人的照片', firstStep: '试一次窗边人像' } }), request => {
    const result = receipt(request)
    assert.equal(result.ok, true)
    assert.equal(result.wish.id, f.wish.id)
    assert.equal(result.wish.version, 2)
    return answer('第一步记好了：试一次窗边人像。想开始时再安排。')
  })
  const request = f.input(evidence)
  await f.xixi.chat(request)
  const saved = f.db.getCompanionState().wishes[0]
  assert.equal(f.db.getCompanionState().wishes.length, 1)
  assert.deepEqual(saved.clarification, { motivation: '拍好家人的照片', firstStep: '试一次窗边人像' })
  assert.equal(saved.minutesEstimated, true)
  assert.deepEqual(saved.items, ['相机'])
  assert.equal(saved.expiresAt, f.wish.expiresAt)
  assert.deepEqual(f.db.listTasks(), [])
  assert.deepEqual(f.db.getPlanner(), planner)
  await f.xixi.chat(request)
  assert.equal(f.db.getCompanionState().wishes[0].version, 2, 'replayed turn is idempotent')
})

test('stale edits and fabricated evidence cannot replace confirmed clarification', async t => {
  const f = fixture(t)
  const saved = f.companion.saveWish({ id: f.wish.id, expectedVersion: 1, content: '学摄影', evidence: '先学习曝光', clarification: { firstStep: '先学习曝光' } })
  for (const args of [
    { expectedVersion: 1, evidence: '改成练习构图' },
    { expectedVersion: saved.version, evidence: '并未说过的原话' },
  ]) {
    f.replies.push(call('remember_wish', { id: f.wish.id, content: '学摄影', clarification: { firstStep: '练习构图' }, ...args }), request => {
      assert.equal(receipt(request).ok, false)
      return answer('这次补充还没保存。')
    })
    await f.xixi.chat(f.input('改成练习构图'))
    assert.deepEqual(f.db.getCompanionState().wishes[0], saved)
  }
})

test('partial clarification preserves confirmed fields, explicit duration and expired wishes', t => {
  const f = fixture(t)
  let wish = f.companion.saveWish({ id: f.wish.id, expectedVersion: 1, content: '学摄影', evidence: '花45分钟练习', minutes: 45, clarification: { motivation: '记录日常', firstStep: '看相机说明书' } })
  wish = f.companion.saveWish({ id: wish.id, expectedVersion: 2, content: wish.content, evidence: '先拍一张', clarification: { firstStep: '拍一张' } })
  assert.deepEqual(wish.clarification, { motivation: '记录日常', firstStep: '拍一张' })
  assert.equal(wish.minutes, 45)
  assert.equal(wish.minutesEstimated, false)
  const later = createCompanion({ db: f.db, now: () => new Date('2026-11-01T08:00:00+08:00') })
  const expired = later.saveWish({ id: wish.id, expectedVersion: 3, content: wish.content, evidence: '仍然想拍照', clarification: { motivation: '仍然想拍照' } })
  assert.equal(expired.expiresAt, wish.expiresAt)
  assert.throws(() => later.saveWish({ id: expired.id, expectedVersion: 4, content: expired.content, evidence: '旧日期', expiresAt: '2026-10-31T08:00:00+08:00' }), /有效期/)
})

test('explicitly selected wish is available with memory disabled; other wishes stay excluded', async t => {
  const f = fixture(t)
  f.companion.saveWish({ content: '未选择的心愿不能泄漏', evidence: '另一份私密心愿' })
  f.db.setPreference('app', { assistant: { useMemory: false, useHistory: false } })
  f.replies.push(request => {
    const context = JSON.stringify(request.messages)
    assert.match(context, /学摄影/)
    assert.doesNotMatch(context, /未选择的心愿不能泄漏|另一份私密心愿/)
    return answer('你想从什么照片开始？')
  })
  await f.xixi.chat(f.input('帮我聊清楚'))
  f.companion.updateWish(f.wish.id, { status: 'deleted', expectedVersion: 1 })
  f.replies.push(request => {
    assert.match(JSON.stringify(request.messages), /selectedWish\\?":null/)
    assert.doesNotMatch(JSON.stringify(request.messages), /学摄影|另一份私密心愿/)
    return answer('这份心愿已经不在清单中了。')
  })
  await f.xixi.chat(f.input('继续'))
  assert.deepEqual(f.db.listTasks(), [])
})

test('clarified wish and selected context survive backup round trip', async t => {
  const f = fixture(t)
  f.companion.saveWish({ id: f.wish.id, expectedVersion: 1, content: f.wish.content, evidence: '拍家人的照片', clarification: { motivation: '记录家人' } })
  f.replies.push(answer('先聊清楚想拍什么。'))
  const input = f.input('聊聊这份心愿')
  await f.xixi.chat(input)
  const backup = f.db.exportData(), restored = createDatabase(':memory:')
  t.after(() => restored.close())
  restored.importData(backup)
  assert.deepEqual(restored.getCompanionState().wishes[0].clarification, { motivation: '记录家人' })
  assert.equal(restored.getTurn(input.requestId).context.wishId, f.wish.id)
})

test('explicit conversion links a single goal and pauses the original wish', async t => {
  const f = fixture(t), evidence = '现在把摄影加入余时，每次20到30分钟'
  f.replies.push(call('save_free_time_goal', { fromWishId: f.wish.id, expectedWishVersion: 1, title: f.wish.content, evidence, sessionMin: 20, sessionMax: 30 }), request => {
    const result = receipt(request)
    assert.equal(result.ok, true)
    assert.equal(result.goal.fromWishId, f.wish.id)
    return answer('已加入余时。')
  })
  await f.xixi.chat(f.input(evidence))
  const state = f.db.getCompanionState()
  assert.equal(state.wishes[0].status, 'paused')
  assert.equal(state.freeTimeGoals.length, 1)
  const again = f.companion.saveFreeTimeGoal({ fromWishId: f.wish.id, expectedWishVersion: 1, title: f.wish.content })
  assert.equal(again.id, state.freeTimeGoals[0].id)
  assert.equal(f.db.getCompanionState().freeTimeGoals.length, 1)
})
