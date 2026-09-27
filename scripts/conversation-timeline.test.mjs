import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { conversationTimeline, mergeConversation } from '../src/xixi/conversationTimeline.ts'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

const at = '2026-09-20T12:00:00.000Z'
const message = (requestId, role, seq, extra = {}) => ({ id: `${requestId}:${role}:${seq}`, requestId, role, seq, content: requestId, createdAt: at, ...extra })
const operation = (requestId, extra = {}) => ({ id: `op:${requestId}`, requestId, summary: requestId, createdAt: at, readAt: null, undoneAt: null, ...extra })
const state = (messages, operations, extra = {}) => ({ conversationId: 'main', messages, operations, oldestSeq: messages[0]?.seq ?? null, hasOlder: false, ...extra })
const receipts = value => conversationTimeline(value).flatMap(row => row.operations.map(item => [row.message.id, item.id]))

test('unloaded old operations never appear underneath the current reply', () => {
  const user = message('current', 'user', 201), reply = message('current', 'assistant', 203)
  const current = state([user, reply], [operation('current'), operation('old-memory'), operation('old-plan'), operation('old-task')], { hasOlder: true })
  assert.deepEqual(receipts(current), [[reply.id, 'op:current']])
  assert.equal(current.operations.length, 4, 'unloaded history remains available instead of being deleted')
})

test('withdrawn turns retain their undo receipts on the original user tombstone', () => {
  const oldUser = message('old', 'user', 1), oldReply = message('old', 'assistant', 3)
  const current = state([oldUser, oldReply, message('current', 'user', 4), message('current', 'assistant', 5)], [operation('old'), operation('current')])
  const withdrawn = mergeConversation(current, state([{ ...oldUser, content: '已撤回', retractedAt: at }], current.operations))
  assert.deepEqual(receipts(withdrawn), [[oldUser.id, 'op:old'], ['current:assistant:5', 'op:current']])
  assert.equal(withdrawn.messages.some(item => item.id === oldReply.id), false)
  const undone = mergeConversation(withdrawn, state(withdrawn.messages, [operation('old', { undoneAt: at }), operation('current')]))
  assert.equal(conversationTimeline(undone)[0].operations[0].undoneAt, at)
})

test('partial success is visible before a final reply and moves to that reply only once', () => {
  const user = message('pending', 'user', 1, { delivery: 'failed' })
  const pending = state([user], [operation('pending')])
  assert.deepEqual(receipts(pending), [[user.id, 'op:pending']])
  const retry = mergeConversation(pending, state([user, message('pending', 'assistant', 3), message('pending', 'assistant', 5)], [operation('pending'), operation('pending')]))
  assert.deepEqual(receipts(retry), [['pending:assistant:5', 'op:pending']])
  assert.deepEqual(receipts(mergeConversation(retry, retry)), receipts(retry))
})

test('loading history then polling preserves original receipt anchors and companion links', () => {
  const allOperations = [operation('old'), operation('current')]
  const oldAction = { id: 'action:old', requestId: 'old', kind: 'scenario', label: '旧草案', createdAt: at }
  const older = state([message('old', 'user', 1), message('old', 'assistant', 3)], allOperations, { companionActions: [oldAction] })
  const current = state([message('current', 'user', 201), message('current', 'assistant', 203)], allOperations, { hasOlder: true })
  const loaded = mergeConversation(older, current)
  assert.deepEqual(receipts(loaded), [['old:assistant:3', 'op:old'], ['current:assistant:203', 'op:current']])
  const polled = mergeConversation(loaded, current)
  assert.deepEqual(receipts(polled), receipts(loaded))
  assert.equal(conversationTimeline(polled)[1].companionActions[0].id, oldAction.id)
  assert.equal(polled.oldestSeq, 1)
  assert.equal(polled.hasOlder, false)
  assert.deepEqual(mergeConversation(polled, { ...current, conversationId: 'another' }).messages, current.messages)
})

function invoke(service, path) {
  return new Promise(resolve => {
    const request = Readable.from([])
    request.url = `/api${path}`
    request.method = 'GET'
    request.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    request.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1' }
    const response = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }
    service.middleware(request, response, () => resolve({ status: 404 }))
  })
}

function fixture(t) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw new Error('No model call expected') } })
  const turn = requestId => db.beginTurn({ requestId, conversationId: 'main', text: requestId, context: {} })
  const commit = requestId => {
    const task = db.createTask({ title: '测试事项' })
    db.applyOperation({ id: `op:${requestId}`, requestId, summary: '更新事项', changes: [{ table: 'tasks', id: task.id, before: task, after: { ...task, title: '已更新' } }] })
  }
  return { db, service, turn, commit }
}

test('tool-only history pages supply their own turn anchor without changing the raw cursor', async t => {
  const { db, service, turn, commit } = fixture(t)
  const old = turn('old')
  commit('old')
  db.finishTurn('old', { status: 'completed' })
  const active = turn('active')
  commit('active')
  for (let i = 0; i < 210; i++) db.appendMessage({ conversationId: 'main', requestId: 'active', role: 'tool', content: '{"ok":true}' })
  const raw = db.listMessages('main', { limit: 200 })
  const current = await invoke(service, '/conversation?id=main')
  assert.equal(current.status, 200)
  assert.equal(current.body.oldestSeq, raw[0].seq)
  assert.equal(current.body.hasOlder, true)
  assert.deepEqual(current.body.messages.map(item => item.id), [active.userMessageId])
  assert.deepEqual(receipts(current.body), [[active.userMessageId, 'op:active']])
  assert.equal(current.body.messages.some(item => item.id === old.userMessageId), false)

  const older = await invoke(service, `/conversation?id=main&before=${current.body.oldestSeq}`)
  const loaded = mergeConversation(older.body, current.body)
  assert.deepEqual(receipts(loaded), [[old.userMessageId, 'op:old'], [active.userMessageId, 'op:active']])
  assert.equal(loaded.messages.filter(item => item.id === active.userMessageId).length, 1)

  db.appendMessage({ conversationId: 'main', requestId: 'active', role: 'assistant', content: '完成' })
  const replied = await invoke(service, '/conversation?id=main')
  const merged = mergeConversation(loaded, replied.body)
  assert.equal(receipts(merged).length, 2)
  assert.equal(receipts(merged)[1][0], replied.body.messages.at(-1).id)
})

test('a withdrawn tool-only turn still exposes its successful changes at its own tombstone', async t => {
  const { db, service, turn, commit } = fixture(t)
  const active = turn('active')
  commit('active')
  for (let i = 0; i < 205; i++) db.appendMessage({ conversationId: 'main', requestId: 'active', role: 'tool', content: '{"ok":true}' })
  db.retractMessage(active.userMessageId)
  const current = await invoke(service, '/conversation?id=main')
  assert.ok(current.body.messages[0].retractedAt)
  assert.deepEqual(receipts(current.body), [[active.userMessageId, 'op:active']])
  db.undoOperation('op:active')
  const undone = await invoke(service, '/conversation?id=main')
  assert.ok(conversationTimeline(undone.body)[0].operations[0].undoneAt)
})
