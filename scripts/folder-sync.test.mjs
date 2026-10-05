import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createFolderSync } from '../desktop/folderSync.mjs'
import { dataDirectory } from '../server/platform.mjs'

function pair(t) {
  const a = createDatabase(':memory:'), b = createDatabase(':memory:')
  t.after(() => { a.close(); b.close() })
  for (const db of [a, b]) { db.listAreas(); db.getPlanner(); db.sync.configure({ groupId: 'c'.repeat(32), directory: '/fake', mode: 'shared' }) }
  const send = (from, to) => { for (const op of from.sync.outbox()) { to.sync.receive(op); from.sync.exported(op.operationId) } }
  send(a, b); send(b, a)
  return { a, b, send }
}

test('transaction outbox is atomic and only includes allowed business facts', t => {
  const { a } = pair(t), before = a.sync.outbox().length
  assert.throws(() => a.transaction(() => { a.createTask({ title: 'rolled back' }); throw new Error('rollback') }))
  assert.equal(a.sync.outbox().length, before)
  a.appendMessage({ conversationId: a.getActiveConversation().id, role: 'user', content: 'PRIVATE_CHAT' })
  a.setPreference('model-connection', { private: 'PRIVATE_SETTING' })
  a.createTask({ title: 'committed' })
  const files = JSON.stringify(a.sync.outbox())
  assert.doesNotMatch(files, /PRIVATE_CHAT|PRIVATE_SETTING/)
  assert.match(files, /committed/)
  assert.equal(a.sync.outbox().length, before + 1)
})

test('duplicate operations, sequence gaps and conflicting identity are handled durably', t => {
  const { a, b } = pair(t)
  const task = a.createTask({ title: 'one' })
  a.updateTask(task.id, { title: 'two' })
  const [first, second] = a.sync.outbox()
  assert.equal(b.sync.receive(second), 'pending')
  assert.equal(b.getTask(task.id), null)
  assert.equal(b.sync.receive(first), 'applied')
  assert.equal(b.sync.receive(second), 'applied')
  assert.equal(b.sync.receive(second), 'duplicate')
  assert.equal(b.getTask(task.id).title, 'two')
  assert.throws(() => b.sync.receive({ ...second, createdAt: '2026-10-06T00:00:00.000Z' }), /内容发生变化/)
})

test('offline distinct-field edits merge, same-field edits wait, local choice converges', t => {
  const { a, b, send } = pair(t)
  const task = a.createTask({ title: 'one', notes: 'base' })
  send(a, b)
  a.updateTask(task.id, { title: 'title from A' })
  b.updateTask(task.id, { notes: 'notes from B' })
  send(a, b); send(b, a)
  assert.equal(a.getTask(task.id).notes, 'notes from B')
  assert.equal(b.getTask(task.id).title, 'title from A')
  a.updateTask(task.id, { title: 'A wins' })
  b.updateTask(task.id, { title: 'B edit' })
  send(b, a)
  const pending = a.sync.pending()[0]
  assert.match(pending.reason, /标题/)
  a.sync.resolve(pending.operationId, 'local')
  send(a, b)
  for (const row of b.sync.pending()) b.sync.resolve(row.operationId, 'remote')
  assert.equal(a.getTask(task.id).title, 'A wins')
  assert.equal(b.getTask(task.id).title, 'A wins')
})

test('tombstones reject resurrection from an old device', t => {
  const { a, b, send } = pair(t)
  const task = a.createTask({ title: 'deleted later' })
  send(a, b)
  const old = b.getTask(task.id)
  a.deleteTask(task.id); send(a, b)
  assert.ok(b.getTask(task.id).deletedAt)
  const prior = a.sync.outbox().length
  a.updateTask(task.id, { deletedAt: null })
  send(a, b)
  assert.ok(b.getTask(task.id).deletedAt)
  assert.match(b.sync.pending()[0].reason, /已删除/)
  assert.equal(prior, 0)
  assert.ok(old)
})

test('incoming schedule conflicts and locked time changes roll back the entire remote transaction', t => {
  const { a, b, send } = pair(t)
  const task = a.createTask({ title: 'locked task' })
  a.updatePlanner({ type: 'save-block', block: { id: 'locked-block', taskId: task.id, date: '2026-10-10', start: '10:00', end: '11:00', locked: false } }, a.getPlanner().revision)
  send(a, b)
  b.updatePlanner({ type: 'save-block', block: { ...b.getPlanner().blocks[0], locked: true } }, b.getPlanner().revision)
  a.updatePlanner({ type: 'save-block', block: { ...a.getPlanner().blocks[0], start: '11:00', end: '12:00' } }, a.getPlanner().revision)
  const incoming = a.sync.outbox().at(-1)
  assert.equal(b.sync.receive(incoming), 'pending')
  assert.equal(b.sync.resolve(incoming.operationId, 'remote'), 'pending')
  assert.equal(b.getPlanner().blocks[0].start, '10:00')
  assert.equal(b.getPlanner().blocks[0].locked, true)
  assert.match(b.sync.pending()[0].reason, /锁定/)
})

test('received task deadline is revalidated against current schedule with atomic rollback', t => {
  const { a, b, send } = pair(t)
  const task = a.createTask({ title: 'scheduled' })
  a.updatePlanner({ type: 'save-block', block: { id: 'slot', taskId: task.id, date: '2026-10-10', start: '10:00', end: '11:00', locked: false } }, a.getPlanner().revision)
  send(a, b)
  a.updateTask(task.id, { due: '2026-10-09', title: 'invalid move' })
  const op = a.sync.outbox().at(-1)
  assert.equal(b.sync.receive(op), 'pending')
  assert.equal(b.getTask(task.id).title, 'scheduled')
  assert.match(b.sync.pending()[0].reason, /截止/)
})

test('goal and per-session completion sync excludes the original conversation source', t => {
  const { a, b, send } = pair(t)
  const task = a.createTask({ title: 'goal task' }), now = new Date().toISOString()
  const source = a.appendMessage({ conversationId: a.getActiveConversation().id, role: 'user', content: 'PRIVATE_GOAL_SOURCE' })
  a.saveCompanionState({ handoffs: [], wishes: [], scenarios: [], freeTimeGoals: [{ id: 'goal', taskId: task.id, title: 'Practice',
    evidence: 'PRIVATE_GOAL_SOURCE', source: { kind: 'conversation', messageId: source.id, evidence: 'PRIVATE_GOAL_SOURCE' },
    priority: 'normal', minPerWeek: 1, sessionMin: 30, sessionMax: 60, status: 'active', version: 1, createdAt: now, updatedAt: now }],
    freeTimeHistory: [{ sessionId: 'session', goalId: 'goal', date: '2026-10-10', minutes: 30, feedback: 'smooth', nextStep: '', completedAt: now }] })
  assert.doesNotMatch(JSON.stringify(a.sync.outbox()), /PRIVATE_GOAL_SOURCE/)
  send(a, b)
  assert.equal(b.sync.pending().length, 0)
  assert.equal(b.getCompanionState().freeTimeHistory[0].sessionId, 'session')
  assert.equal(b.getCompanionState().freeTimeGoals[0].source.kind, 'user')
})

test('shared directory encrypts files, survives repeat scans, rejects bad keys and does not share SQLite', async t => {
  const root = await mkdtemp(join(tmpdir(), 'astaria-sync-test-'))
  const ad = join(root, 'a'), bd = join(root, 'b'), folder = join(root, 'shared')
  for (const path of [ad, bd, folder]) await mkdir(path)
  const a = createDatabase(join(ad, 'test.sqlite')), b = createDatabase(join(bd, 'test.sqlite'))
  const vault = () => { const entries = new Map(); return { available: () => true, read: key => entries.get(key), write: (key, value) => entries.set(key, value), remove: key => entries.delete(key) } }
  const av = vault(), bv = vault()
  const as = createFolderSync({ store: a.sync, secrets: av, dataDirectory: ad })
  const bs = createFolderSync({ store: b.sync, secrets: bv, dataDirectory: bd })
  t.after(async () => { await as.close(); await bs.close(); a.close(); b.close(); await rm(root, { recursive: true, force: true }) })
  a.listAreas(); b.listAreas(); a.getPlanner(); b.getPlanner()
  await as.configure({ mode: 'shared', create: true, directory: folder })
  await assert.rejects(bs.configure({ mode: 'shared', create: false, directory: folder, joinKey: '0'.repeat(64) }), /不匹配/)
  await bs.configure({ mode: 'shared', create: false, directory: folder, joinKey: av.read('sync-key') })
  const task = a.createTask({ title: 'PRIVATE_TASK_TITLE' })
  await as.run(); await bs.run(); await bs.run()
  assert.equal(b.getTask(task.id)?.title, 'PRIVATE_TASK_TITLE')
  const ops = join(folder, '.astaria-sync', 'devices', a.sync.config().deviceId, 'operations')
  for (const name of await readdir(ops)) assert.doesNotMatch((await readFile(join(ops, name))).toString(), /PRIVATE_TASK_TITLE|sqlite/)
  await writeFile(join(ops, 'incomplete.partial'), 'partial')
  await bs.run()
  assert.match(bs.status().message, /未完成|未完整/)
  const first = (await readdir(ops)).find(name => name.endsWith('.op'))
  await writeFile(join(ops, first), 'broken')
  await bs.run()
  assert.match(bs.status().message, /未完成/)
})

test('Windows data directory preserves Chinese paths and honors APPDATA', () => {
  assert.equal(dataDirectory({ platform: 'win32', home: 'C:\\Users\\中文', appData: 'D:\\用户资料' }), 'D:\\用户资料\\ASTaria')
})

test('startAt-only tasks cannot merge into overlapping time or pass their deadline', t => {
  const { a, b, send } = pair(t)
  const first = a.createTask({ title: 'A', startAt: new Date('2026-10-10T10:00:00').toISOString(), estimateMin: 60 })
  send(a, b)
  b.createTask({ title: 'B', startAt: new Date('2026-10-10T12:00:00').toISOString(), estimateMin: 60 })
  a.updateTask(first.id, { startAt: new Date('2026-10-10T12:30:00').toISOString() })
  const overlap = a.sync.outbox().at(-1)
  assert.equal(b.sync.receive(overlap), 'pending')
  assert.match(b.sync.pending()[0].reason, /冲突/)
  assert.equal(b.getTask(first.id).startAt, first.startAt)
  assert.equal(b.sync.resolve(overlap.operationId, 'local'), 'kept-local')
  a.updateTask(first.id, { due: '2026-10-09' })
  const overdue = a.sync.outbox().at(-1)
  assert.equal(b.sync.receive(overdue), 'pending')
  assert.match(b.sync.pending()[0].reason, /截止/)
  assert.equal(b.getTask(first.id).due, first.due)
})

test('Syncthing marker, pause, receipts, pending gaps and last check survive database reopen', async t => {
  const root = await mkdtemp(join(tmpdir(), 'astaria-sync-restart-'))
  const local = join(root, '本机数据'), folder = join(root, '共享目录')
  for (const path of [local, folder]) await mkdir(path)
  const path = join(local, 'test.sqlite'), entries = new Map()
  const secrets = { available: () => true, read: key => entries.get(key), write: (key, value) => entries.set(key, value), remove: key => entries.delete(key) }
  let db = createDatabase(path), sync = createFolderSync({ store: db.sync, secrets, dataDirectory: local })
  const other = createDatabase(':memory:')
  t.after(async () => { await sync.close(); db.close(); other.close(); await rm(root, { recursive: true, force: true }) })
  db.getPlanner(); other.getPlanner()
  await assert.rejects(sync.configure({ mode: 'syncthing', create: true, directory: folder }), /标记/)
  await mkdir(join(folder, '.stfolder'))
  await sync.configure({ mode: 'syncthing', create: true, directory: folder })
  other.sync.configure({ ...db.sync.config() })
  const task = other.createTask({ title: 'persisted gap' })
  other.updateTask(task.id, { notes: 'after predecessor' })
  const ops = other.sync.outbox()
  assert.equal(db.sync.receive(ops.at(-1)), 'pending')
  db.createTask({ title: 'outbox survives pause' })
  await sync.pause(true)
  const before = sync.status()
  assert.ok(before.lastCheckedAt)
  assert.equal(before.pendingExports, 1)
  await sync.close(); db.close()
  db = createDatabase(path); sync = createFolderSync({ store: db.sync, secrets, dataDirectory: local })
  assert.equal(sync.status().lastCheckedAt, before.lastCheckedAt)
  assert.equal(sync.status().paused, true)
  assert.equal(sync.status().pendingExports, 1)
  assert.deepEqual(sync.status().receipts, before.receipts)
  assert.equal(db.sync.pending().length, 1)
  for (const op of ops) db.sync.receive(op)
  assert.equal(db.sync.pending().length, 0)
  assert.equal(db.getTask(task.id).notes, 'after predecessor')
  assert.ok(sync.status().receipts.some(receipt => receipt.outcome === 'applied'))
  await sync.pause(false)
  assert.equal(sync.status().pendingExports, 0)
  await rm(join(folder, '.stfolder'), { recursive: true })
  await sync.run()
  assert.match(sync.status().message, /未完成/)
})

test('closing during a native directory picker waits and does not configure a group afterwards', async () => {
  const db = createDatabase(':memory:')
  let finishPicker
  const picker = new Promise(resolve => { finishPicker = resolve })
  const sync = createFolderSync({ store: db.sync, secrets: { available: () => true }, dataDirectory: '/unused', selectDirectory: () => picker })
  try {
    const configure = sync.configure({ mode: 'shared', create: true })
    await Promise.resolve()
    let closed = false
    const closing = sync.close().then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false)
    finishPicker('/never-accessed')
    await Promise.all([configure, closing])
    assert.equal(closed, true)
    assert.equal(db.sync.config(), null)
  } finally { db.close() }
})
