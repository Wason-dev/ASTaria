import assert from 'node:assert/strict'
import test from 'node:test'
import { createIndexedDBPendingChatAdapter, createPendingChatRequestStore } from '../src/xixi/pendingChatRequest.ts'

// All persistence below is synthetic and in memory. Exercise the production
// IndexedDB adapter's cursor/transaction behavior without opening user storage.
const original = {
  requestId: 'failed-original', conversationId: 'conversation-a', text: '原始失败请求', seq: 7,
  createdAt: '2025-01-01T00:00:00.000Z',
  context: { page: 'calendar', timezone: 'Europe/Paris', date: '2026-10-24', taskId: 'task-a', wishId: 'wish-a', freeTimeGoalId: 'goal-a' },
  attachments: [{ kind: 'image', name: 'tiny.png', mime: 'image/png', size: 3, data: 'data:image/png;base64,AQID' }],
}
const tick = () => new Promise(resolve => setImmediate(resolve))

function database(initial) {
  const rows = structuredClone(initial), transactions = []
  let failDelete = false
  const db = {
    close() {},
    transaction(_name, mode) {
      transactions.push(mode)
      const tx = { objectStore: () => store, abort: () => queueMicrotask(() => tx.onabort()) }
      const finish = () => queueMicrotask(() => tx.oncomplete())
      const request = value => {
        const result = { result: structuredClone(value) }
        queueMicrotask(() => { result.onsuccess?.(); finish() })
        return result
      }
      const store = {
        index: () => ({ getAll: scopeId => request(rows.filter(row => row.scopeId === scopeId)) }),
        put: row => {
          const index = rows.findIndex(item => item.scopeId === row.scopeId && item.requestId === row.requestId)
          if (index >= 0) rows[index] = structuredClone(row)
          else rows.push(structuredClone(row))
          return request(row.requestId)
        },
        delete: ([scopeId, requestId]) => {
          if (failDelete) { queueMicrotask(() => { tx.error = new Error('transaction aborted'); tx.onabort() }); return }
          const index = rows.findIndex(row => row.scopeId === scopeId && row.requestId === requestId)
          if (index >= 0) rows.splice(index, 1)
          finish()
        },
        openCursor: () => {
          let index = 0
          const cursorRows = [...rows]
          const req = {}
          const next = () => queueMicrotask(() => {
            req.result = index < cursorRows.length ? { value: structuredClone(cursorRows[index++]), continue: next } : null
            req.onsuccess()
            if (!req.result) finish()
          })
          next()
          return req
        },
      }
      return tx
    },
  }
  const adapter = createIndexedDBPendingChatAdapter(() => ({ open() {
    const opening = { result: db }
    queueMicrotask(() => opening.onsuccess())
    return opening
  } }))
  return { rows, transactions, adapter, failDeletion: () => { failDelete = true } }
}

function windowStore(adapter, id) {
  const session = new Map()
  return createPendingChatRequestStore({ adapter, createId: () => id, session: {
    getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value),
  } })
}

test('R15 native lookup reads only the exact identity and never writes or claims another scope', async () => {
  const db = database([
    { ...original, scopeId: 'closed-window' },
    { ...original, requestId: 'still-running', scopeId: 'active-window' },
    { ...original, conversationId: 'conversation-b', scopeId: 'another-window' },
  ])
  const before = structuredClone(db.rows)
  const fresh = windowStore(db.adapter, 'new-window')
  assert.deepEqual(await fresh.list(), [])
  assert.deepEqual(await fresh.find(original.conversationId, original.requestId), original)
  assert.deepEqual(await fresh.find('missing', original.requestId), null)
  assert.deepEqual(db.rows, before)
  assert.ok(db.transactions.every(mode => mode === 'readonly'))
})

test('R15 recovered identity commits locally, survives reload and cleans only the receiving scope', async () => {
  const db = database([{ ...original, scopeId: 'old-window' }])
  const fresh = windowStore(db.adapter, 'new-window')
  const request = await fresh.find(original.conversationId, original.requestId)
  await fresh.save(request)
  assert.deepEqual(await fresh.list(), [original])
  const reopened = windowStore(db.adapter, 'new-window')
  // Establish a new session pointing at the same durable scope.
  await reopened.save(original)
  assert.deepEqual(await reopened.list(), [original])
  await reopened.remove([original.requestId])
  assert.deepEqual(db.rows, [{ ...original, scopeId: 'old-window' }])
  assert.deepEqual(await fresh.list(), [], 'stale session indexes cannot resurrect a deleted record')
})

test('R15 conflicting copies of a request fail closed and preserve both original records', async () => {
  const db = database([{ ...original, scopeId: 'one' }, { ...original, context: { ...original.context, date: '2026-10-25' }, scopeId: 'two' }])
  const before = structuredClone(db.rows)
  await assert.rejects(windowStore(db.adapter, 'fresh').find(original.conversationId, original.requestId), /不一致/)
  assert.deepEqual(db.rows, before)
  assert.ok(db.transactions.every(mode => mode === 'readonly'))
})

test('R15 optimistic and server timestamps do not change the identity of otherwise identical copies', async () => {
  const db = database([{ ...original, scopeId: 'one' }, { ...original, seq: 42, createdAt: '2026-10-24T00:00:00.100Z', scopeId: 'two' }])
  const before = structuredClone(db.rows)
  assert.deepEqual(await windowStore(db.adapter, 'fresh').find(original.conversationId, original.requestId), original)
  assert.deepEqual(db.rows, before)
})

test('R15 failed cleanup leaves the current and original windows retryable without losing attachments', async () => {
  const db = database([{ ...original, scopeId: 'old-window' }])
  const fresh = windowStore(db.adapter, 'new-window')
  await fresh.save(await fresh.find(original.conversationId, original.requestId))
  db.failDeletion()
  await assert.rejects(fresh.remove([original.requestId]), /transaction aborted/)
  await tick()
  assert.deepEqual(await fresh.list(), [original])
  assert.equal(db.rows.length, 2)
  assert.deepEqual(db.rows.map(row => row.attachments), [original.attachments, original.attachments])
})

// This adapter double models transaction semantics for cross-scope collection;
// other tests above execute the production IndexedDB cursor implementation.
test('R15 confirmed completed identity releases old scopes without touching running or other-topic records', async()=>{
  const rows=[{...original,scopeId:'closed'},{...original,scopeId:'current'},
    {...original,requestId:'running',scopeId:'active'},{...original,conversationId:'other',scopeId:'other'}]
  const adapter={
    list:async scope=>rows.filter(r=>r.scopeId===scope),put:async()=>{},remove:async()=>{},
    removeConfirmed:async(conversationId,ids)=>{for(let i=rows.length-1;i>=0;i--)if(rows[i].conversationId===conversationId&&ids.includes(rows[i].requestId))rows.splice(i,1)}
  }
  const store=windowStore(adapter,'current')
  await store.removeConfirmed(original.conversationId,[original.requestId])
  assert.deepEqual(rows.map(r=>r.scopeId),['active','other'])
})

test('R15 real adapter collects adjacent terminal records in different scopes only after confirmation',async()=>{
  const db=database([{...original,scopeId:'old-a'},{...original,scopeId:'old-b'},
    {...original,requestId:'running',scopeId:'active'},{...original,conversationId:'other',scopeId:'other'}])
  const fresh=windowStore(db.adapter,'fresh')
  await fresh.removeConfirmed(original.conversationId,[original.requestId])
  await tick()
  assert.deepEqual(db.rows.map(row=>row.scopeId),['active','other'])
})
