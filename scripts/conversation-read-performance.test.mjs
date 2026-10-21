// In-memory regression for the real shared database/service on both engines.
// The frozen pre-optimization view below is an independent behavioural oracle;
// assertions compare complete results, executed queries and JSON.parse calls.
// No files, real data, credentials, sockets, providers or timers are opened.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import initSqlJs from 'sql.js'
import { sqliteDriver } from '../mobile/runtime/sqlite.mjs'
import { createDatabaseCore } from '../server/databaseCore.mjs'
import { createServiceCore } from '../server/serviceCore.mjs'
import { normalizeAssistantProtocol } from '../server/provider-protocol.mjs'
import { publicOperations } from '../server/operationReceipts.mjs'
import { isSourceMetadataList, uniqueSourceMetadata } from '../src/xixi/sourceMetadata.ts'

const SQL = await initSqlJs()
const at = '2026-10-15T00:00:00.000Z'
const progressMarker = 'SYNTHETIC_LARGE_PROGRESS_NEVER_NEEDED_FOR_READ'
const progress = { marker: progressMarker, content: '进度'.repeat(40_000), activities: ['synthetic'] }
const projectionCount = queries => queries.filter(query => /FROM turns WHERE id IN/i.test(query.sql)).length
const fullTurnReads = queries => queries.filter(query => /SELECT document FROM turns/i.test(query.sql)).length

function fixture(t, engine) {
  const native = engine === 'node:sqlite' ? new DatabaseSync(':memory:') : new SQL.Database()
  const driver = engine === 'node:sqlite' ? native : sqliteDriver(native)
  const queries = []
  const measuredDriver = {
    exec: sql => driver.exec(sql),
    prepare(sql) {
      const statement = driver.prepare(sql)
      return Object.fromEntries(['get', 'all', 'run'].map(method => [method, (...args) => {
        const result = statement[method](...args)
        queries.push({ sql, args, method, result })
        return result
      }]))
    },
  }
  const db = createDatabaseCore(measuredDriver, {
    ownerPid: 1, processAlive: () => true,
    // Unused factories only satisfy the core's construction contract. These
    // tests never load, export or restore any backup or sync data.
    createBackupStore: () => ({ exportData() { throw Error('No backup access') }, importData() { throw Error('No backup access') } }),
  })
  const service = createServiceCore({ db, xixiFactory: () => ({}),
    complete: async () => { throw Error('No model calls') },
    vault: { status: async () => { throw Error('No vault calls') } },
    fetcher: async () => { throw Error('No network calls') },
  })
  t.after(() => native.close())
  const put = (table, id, value) => {
    assert.ok(['turns', 'operations', 'tasks'].includes(table))
    driver.prepare(`INSERT OR REPLACE INTO ${table} (id,document) VALUES (?,?)`).run(id, JSON.stringify(value))
  }
  const conversation = id => driver.prepare('INSERT OR IGNORE INTO conversations(id,title,createdAt,updatedAt,titleEdited) VALUES (?,?,?,?,0)').run(id, `合成 ${id}`, at, at)
  const message = (conversationId, id, value) => {
    const document = { id, conversationId, createdAt: at, content: id, excludeFromContext: false, ...value }
    driver.prepare('INSERT INTO messages(id,conversationId,role,document) VALUES (?,?,?,?)').run(id, conversationId, document.role, JSON.stringify(document))
    return db.getMessage(id)
  }
  const patchMessage = (id, patch) => {
    const { seq, ...document } = db.getMessage(id)
    driver.prepare('UPDATE messages SET document = ? WHERE id = ?').run(JSON.stringify({ ...document, ...patch }), id)
  }
  const turn = (id, conversationId, extra = {}) => {
    put('turns', id, { requestId: id, conversationId, userMessageId: `${id}:user`, status: 'completed', createdAt: at, updatedAt: at, progress, ...extra })
  }
  return { db, driver, queries, service, put, conversation, message, patchMessage, turn }
}

// Retains the old publicMessage and raw.filter-per-visible-message logic,
// including the intentionally distinct contextRetractedAt checks. Changing the
// optimized implementation cannot silently change the expected response here.
function legacyPublicMessage(raw) {
  const { id, seq, role, content, createdAt, requestId, taskId, excludeFromContext, question, retractedAt, reasoningContent, attachments, executionNotice, sources } = raw.role === 'assistant' && !raw.retractedAt ? normalizeAssistantProtocol(raw) : raw
  return {
    id, seq, role, content: retractedAt ? '已撤回' : content, createdAt, requestId, taskId, excludeFromContext,
    ...(retractedAt ? { retractedAt } : { question, ...(attachments?.length ? { attachments } : {}), ...(role === 'assistant' && reasoningContent ? { reasoningContent } : {}), ...(executionNotice ? { executionNotice } : {}), ...(role === 'assistant' && !excludeFromContext && !raw.contextRetractedAt && isSourceMetadataList(sources) ? { sources: uniqueSourceMetadata(sources) } : {}) }),
  }
}
function legacyView(db, id, before) {
  const raw = db.listMessages(id, { limit: 200, ...(before === undefined ? {} : { before }) })
  const oldestSeq = raw[0]?.seq ?? null
  const messages = raw.filter(message => message.role !== 'tool' && !message.toolCalls?.length && !(message.retractedAt && message.role === 'assistant'))
  const visibleRequests = new Set(messages.map(message => message.requestId))
  for (const requestId of new Set(raw.map(message => message.requestId).filter(Boolean))) {
    if (visibleRequests.has(requestId)) continue
    const turn = db.getTurn(requestId)
    const anchor = turn?.conversationId === id ? db.getMessage(turn.userMessageId) : null
    if (anchor?.role === 'user') messages.push(anchor)
  }
  const savedReasoning = new Set(messages.filter(message => !message.retractedAt && message.requestId)
    .map(message => message.requestId).filter((requestId, index, ids) => ids.indexOf(requestId) === index)
    .filter(requestId => db.hasSavedReasoning(id, requestId)))
  return {
    conversationId: id,
    contextUsage: null,
    messages: messages.sort((a, b) => a.seq - b.seq).map(message => {
      const visible = { ...legacyPublicMessage(message), ...(!message.retractedAt && savedReasoning.has(message.requestId) ? { hasSavedReasoning: true } : {}) }
      if (message.role !== 'assistant' || message.retractedAt || !message.requestId) return visible
      const thoughts = raw.filter(item => item.requestId === message.requestId && item.role === 'assistant' && !item.retractedAt && !item.excludeFromContext)
        .map(item => item.reasoningContent).filter(Boolean).join('\n\n')
      return thoughts ? { ...visible, reasoningContent: thoughts.length > 120_000 ? `${thoughts.slice(0, 120_000)}\n\n（思考内容较长，展示已截短）` : thoughts } : visible
    }),
    operations: publicOperations(db.listOperations().filter(operation => db.getTurn(operation.requestId)?.conversationId === id), db),
    companionActions: raw.filter(message => message.role === 'tool' && !message.retractedAt && !message.excludeFromContext).flatMap(message => {
      try {
        const value = JSON.parse(message.content)
        if (!value.ok) return []
        const kind = value.scenario ? 'scenario' : value.handoff ? 'handoff' : value.wish ? 'wish' : value.goal ? 'goal' : null
        if (!kind) return []
        const record = value[kind]
        return [{ id: message.id, requestId: message.requestId, kind, label: kind === 'scenario' ? '推演草案已生成 · 查看后再应用' : kind === 'handoff' ? '接力现场已保存' : kind === 'goal' ? '余时目标已更新' : '牵挂清单已更新', ...(kind === 'scenario' ? { targetId: record.id } : {}), createdAt: message.createdAt }]
      } catch { return [] }
    }),
    oldestSeq, hasOlder: oldestSeq !== null && db.listMessages(id, { limit: 1, before: oldestSeq }).length > 0,
  }
}
function legacyWritable(db, requestId, sourceMessageIds = []) {
  const fail = (message, status = 400) => { const error = Error(message); error.status = status; throw error }
  if (!Array.isArray(sourceMessageIds)) fail('消息来源列表不正确')
  if (requestId && db.driver.prepare('SELECT 1 FROM state WHERE key = ?').get(`deleted-request:${requestId}`)) fail('这段对话已删除，回复已停止', 410)
  const turn = requestId ? db.getTurn(requestId) : null
  if (turn?.retractedAt) fail('这条消息已撤回，不再继续处理', 409)
  if (sourceMessageIds.some(id => {
    const message = db.getMessage(id)
    return !message || message.retractedAt || message.contextRetractedAt
  })) fail('相关消息已撤回或删除，这次回复已停止，请重新发送', 409)
}
const resultOf = action => { try { return { result: action() } } catch (error) { return { error: error.message, status: error.status } } }

async function measure(f, action) {
  const parse = JSON.parse
  let progressParses = 0, requestReads = 0
  const originalList = f.db.listMessages
  f.db.listMessages = (...args) => originalList(...args).map(message => new Proxy(message, {
    get(target, key, receiver) { if (key === 'requestId') requestReads++; return Reflect.get(target, key, receiver) },
  }))
  JSON.parse = function (value, ...args) {
    if (typeof value === 'string' && value.includes(progressMarker)) progressParses++
    return parse.call(this, value, ...args)
  }
  f.queries.length = 0
  try {
    const value = await action()
    return { value, progressParses, requestReads, queries: [...f.queries] }
  } finally { JSON.parse = parse; f.db.listMessages = originalList }
}

function seedHistory(f) {
  for (const id of ['main', 'other', 'tools', 'empty']) f.conversation(id)
  f.turn('unloaded', 'main'); f.message('main', 'unloaded:user', { requestId: 'unloaded', role: 'user' })
  f.message('main', 'unloaded:thought', { requestId: 'unloaded', role: 'assistant', reasoningContent: '旧页完整思考', toolCalls: [{ id: 'old-call' }] })
  // Exactly 200 rows: 40 requests with hidden native thoughts, a tool result,
  // user and visible reply. No artificial truncation of the tested page.
  for (let index = 0; index < 40; index++) {
    const requestId = `turn-${index}`
    f.turn(requestId, 'main')
    f.message('main', `${requestId}:user`, { requestId, role: 'user', ...(index === 1 ? { retractedAt: at } : {}), ...(index === 2 ? { attachments: [{ name: 'fixture.png', mime: 'image/png', size: 1, data: 'data:image/png;base64,AA==' }] } : {}) })
    f.message('main', `${requestId}:thought1`, { requestId, role: 'assistant', content: '', reasoningContent: index === 0 ? '一'.repeat(80_000) : `前段 ${index}`, toolCalls: [{ id: `call-${index}` }] })
    const kind = ['scenario', 'handoff', 'wish', 'goal'][index % 4]
    f.message('main', `${requestId}:tool`, { requestId, role: 'tool', content: index === 8 ? 'invalid JSON' : JSON.stringify({ ok: index !== 9, [kind]: { id: `companion-${index}` } }), ...(index === 10 ? { excludeFromContext: true } : {}), ...(index === 11 ? { retractedAt: at } : {}) })
    f.message('main', `${requestId}:thought2`, { requestId, role: 'assistant', content: index === 5 ? '中间可见回复' : '', reasoningContent: index === 0 ? '二'.repeat(70_000) : `后段 ${index}`, ...(index === 5 ? {} : { toolCalls: [{ id: `second-call-${index}` }] }), ...(index === 6 ? { excludeFromContext: true } : {}), ...(index === 7 ? { retractedAt: at } : {}) })
    const sources = [{ url: 'https://example.invalid/page', title: '完整来源', fetchStatus: 'ok', fetchedAt: at }, { url: 'https://example.invalid/page', title: '重复来源', fetchStatus: 'failed', fetchedAt: at }]
    f.message('main', `${requestId}:reply`, { requestId, role: 'assistant', content: index === 4 ? '<think>协议思考</think>\n正文' : `完整回复 ${index}`, reasoningContent: `尾段 ${index}`, sources, ...(index === 12 ? { excludeFromContext: true } : {}), ...(index === 13 ? { contextRetractedAt: at } : {}), ...(index === 14 ? { retractedAt: at } : {}), ...(index === 15 ? { question: { options: ['继续', '暂停'] }, executionNotice: { issues: ['等待核对'], replyUnavailable: true } } : {}) })
    const task = { id: `task-${index}`, title: `事项 ${index}`, due: '2026-10-16', estimateMin: 30, updatedAt: at, createdAt: at, ...(index === 3 ? { deletedAt: at } : {}) }
    f.put('tasks', task.id, task)
    for (let receipt = 0; receipt < 3; receipt++) {
      const id = `op-${index}-${receipt}`
      f.put('operations', id, { id, requestId, summary: receipt ? '安排 1 段任务时间' : '创建事项', createdAt: at, readAt: receipt === 2 ? at : null, undoneAt: index === 16 ? at : null,
        ...(receipt ? { kind: 'planner', parentOperationId: `op-${index}-0`, planChanges: [{ before: null, after: { id: `block-${index}-${receipt}`, taskId: task.id, date: '2026-10-15', start: '10:00', end: '10:30' } }], changes: [] } : { changes: [{ table: 'tasks', id: task.id, before: null, after: task }] }) })
    }
  }
  for (const requestId of ['outside', 'missing-turn', 'unloaded']) {
    if (requestId === 'outside') { f.turn(requestId, 'other'); f.message('other', `${requestId}:user`, { requestId, role: 'user' }); f.message('other', `${requestId}:reply`, { requestId, role: 'assistant', reasoningContent: '另一个topic思考' }) }
    f.put('operations', `op-${requestId}`, { id: `op-${requestId}`, requestId, summary: requestId, changes: [], createdAt: at, readAt: null, undoneAt: null, undoable: false })
  }
  f.turn('tool-only', 'tools')
  f.message('tools', 'tool-only:user', { requestId: 'tool-only', role: 'user' })
  for (let i = 0; i < 205; i++) f.message('tools', `tool-only:${i}`, { requestId: 'tool-only', role: i % 2 ? 'tool' : 'assistant', content: '', ...(i % 2 ? {} : { reasoningContent: `隐藏段 ${i}`, toolCalls: [{ id: `tool-${i}` }] }) })
  f.put('operations', 'op-tools', { id: 'op-tools', requestId: 'tool-only', summary: '工具轮回执', changes: [], createdAt: at, readAt: null, undoneAt: null })
}

for (const engine of ['node:sqlite', 'sql.js']) {
  test(`${engine}: 200-row multi-round view matches the complete legacy response with bounded turn reads`, async t => {
    const f = fixture(t, engine); seedHistory(f)
    const before = await measure(f, () => legacyView(f.db, 'main'))
    const after = await measure(f, () => f.service.dispatch('/api/conversation?id=main'))
    assert.deepEqual(after.value, before.value)
    assert.equal(f.db.listMessages('main', { limit: 200 }).length, 200)
    assert.equal(after.value.messages.find(message => message.id === 'turn-0:reply').reasoningContent, '一'.repeat(80_000) + '\n\n' + '二'.repeat(39_998) + '\n\n（思考内容较长，展示已截短）')
    assert.ok(after.value.operations.some(op => op.id === 'op-unloaded'), 'unloaded receipt remains available')
    assert.ok(!after.value.operations.some(op => op.id === 'op-outside' || op.id === 'op-missing-turn'))
    assert.equal(before.progressParses, 123); assert.equal(after.progressParses, 0)
    assert.equal(fullTurnReads(after.queries), 0); assert.equal(projectionCount(after.queries), 1)
    assert.ok(after.requestReads < before.requestReads / 4, 'single request aggregation removes repeated raw scans')
    t.diagnostic(JSON.stringify({ pageRows: 200, operations: f.db.listOperations().length,
      before: { progressParses: before.progressParses, fullTurnReads: fullTurnReads(before.queries), requestFieldReads: before.requestReads, totalQueries: before.queries.length },
      after: { progressParses: after.progressParses, fullTurnReads: fullTurnReads(after.queries), turnProjectionQueries: projectionCount(after.queries), requestFieldReads: after.requestReads, totalQueries: after.queries.length } }))
  })

  test(`${engine}: tool-only pagination, tombstones, sources and other topics retain full view equivalence`, async t => {
    const f = fixture(t, engine); seedHistory(f)
    for (const id of ['main', 'other', 'tools', 'empty', 'unknown']) {
      const first = await f.service.dispatch(`/api/conversation?id=${id}`)
      assert.deepEqual(first, legacyView(f.db, id), `${id}: current page`)
      if (first.oldestSeq > 1) assert.deepEqual(await f.service.dispatch(`/api/conversation?id=${id}&before=${first.oldestSeq}`), legacyView(f.db, id, first.oldestSeq), `${id}: older page`)
    }
    const tools = await f.service.dispatch('/api/conversation?id=tools')
    assert.deepEqual(tools.messages.map(message => message.id), ['tool-only:user'])
    assert.equal(tools.hasOlder, true)
    // Real database retraction leaves the successful receipt but removes the
    // source/assistant/reasoning visibility exactly as before.
    f.db.retractMessage('tool-only:user')
    assert.deepEqual(await f.service.dispatch('/api/conversation?id=tools'), legacyView(f.db, 'tools'))
    f.db.retractMessage('turn-0:user')
    assert.deepEqual(await f.service.dispatch('/api/conversation?id=main'), legacyView(f.db, 'main'))
    f.db.deleteConversation('other')
    assert.deepEqual(await f.service.dispatch('/api/conversation?id=other'), legacyView(f.db, 'other'))
    assert.ok(!(await f.service.dispatch('/api/conversation?id=main')).operations.some(op => op.id === 'op-outside'))
  })

  test(`${engine}: batched parameterized projections deduplicate IDs and never parse progress`, async t => {
    const f = fixture(t, engine); f.conversation('main')
    const ids = Array.from({ length: 1003 }, (_, i) => `projection-${i}`)
    const quoted = "literal'); DROP TABLE turns; --"
    ids.push(quoted)
    for (const id of ids) f.turn(id, 'main', { progress: { marker: progressMarker } })
    const measured = await measure(f, () => f.db.getTurnReferences([...ids, ...ids, 'missing']))
    assert.equal(measured.value.length, ids.length)
    assert.deepEqual(new Map(measured.value.map(row => [row.requestId, { ...row }])), new Map(ids.map(id => [id, { requestId: id, conversationId: 'main', userMessageId: `${id}:user` }])))
    assert.equal(measured.progressParses, 0); assert.equal(projectionCount(measured.queries), 3)
    assert.ok(measured.queries.every(query => query.args.length <= 400))
    assert.ok(measured.queries.some(query => query.args.includes(quoted)))
    assert.ok(measured.queries.every(query => !query.sql.includes(quoted)))
    assert.ok(measured.queries.flatMap(query => query.result).every(row => Object.keys(row).sort().join(',') === 'conversationId,requestId,userMessageId'))
    const empty = await measure(f, () => f.db.getTurnReferences([]))
    assert.deepEqual(empty.value, []); assert.equal(empty.queries.length, 0)
    assert.throws(() => f.db.getTurnReferences(null), /请求标识列表/)
    assert.throws(() => f.db.getTurnReferences(['good', '\u0000bad']), /无效字符/)
  })

  test(`${engine}: 40ms monitor's writable checks use projections with identical withdrawal/deletion errors`, async t => {
    const f = fixture(t, engine); f.conversation('main'); f.conversation('other')
    f.turn('active', 'main'); f.turn('withdrawn', 'main', { retractedAt: at })
    f.message('main', 'active:user', { requestId: 'active', role: 'user', content: '大来源'.repeat(12_000) })
    f.message('main', 'source-excluded', { role: 'assistant', excludeFromContext: true, reasoningContent: '完整大思考'.repeat(10_000) })
    f.message('main', 'source-retracted', { role: 'user', retractedAt: at })
    f.message('main', 'source-context', { role: 'assistant', contextRetractedAt: at })
    f.driver.prepare('INSERT INTO state(key,value) VALUES (?,?)').run('deleted-request:deleted', at)
    const legacy = { ...f.db, driver: f.driver }
    const cases = [
      [undefined, []], [null, []], ['', []], ['missing', []], [' active ', ['active:user']],
      ['active', []], ['active', ['active:user', 'source-excluded']], ['withdrawn', []],
      ['deleted', []], ['deleted', ['source-context']], ['withdrawn', ['missing-source']],
      ['active', ['source-retracted']], ['active', ['source-context']], ['active', ['missing-source']],
      [undefined, ['source-retracted']], ['active', null], ['active', ['\u0000bad']], ['\u0000bad', []],
    ]
    for (const [requestId, sources] of cases) assert.deepEqual(resultOf(() => f.db.assertTurnWritable(requestId, sources)), resultOf(() => legacyWritable(legacy, requestId, sources)), `${String(requestId)} / ${JSON.stringify(sources)}`)
    const before = await measure(f, () => { for (let i = 0; i < 25; i++) legacyWritable(legacy, 'active', ['active:user', 'source-excluded']) })
    const after = await measure(f, () => { for (let i = 0; i < 25; i++) f.db.assertTurnWritable('active', ['active:user', 'source-excluded']) })
    assert.equal(before.progressParses, 25); assert.equal(after.progressParses, 0)
    assert.equal(fullTurnReads(after.queries), 0)
    assert.ok(after.queries.every(query => query.result === undefined || !Object.hasOwn(query.result, 'document')))
    assert.deepEqual(resultOf(() => f.db.assertTurnWritable('withdrawn')), { error: '这条消息已撤回，不再继续处理', status: 409 })
    assert.deepEqual(resultOf(() => f.db.assertTurnWritable('deleted')), { error: '这段对话已删除，回复已停止', status: 410 })
    // Real lifecycle mutations remain immediately visible; projections are not
    // cached and have no influence on the existing monitor's 40ms interval.
    f.db.retractMessage('active:user')
    assert.deepEqual(resultOf(() => f.db.assertTurnWritable('active')), resultOf(() => legacyWritable(legacy, 'active')))
    f.db.deleteConversation('main')
    assert.deepEqual(resultOf(() => f.db.assertTurnWritable('active')), { error: '这段对话已删除，回复已停止', status: 410 })
    assert.deepEqual(resultOf(() => f.db.assertTurnWritable('active')), resultOf(() => legacyWritable(legacy, 'active')))
    t.diagnostic(JSON.stringify({ checks: 25, beforeProgressParses: before.progressParses, afterProgressParses: after.progressParses, queriesPerCheck: after.queries.length / 25 }))
  })
}
