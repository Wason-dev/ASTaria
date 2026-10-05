import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { mergeSyncDocument, syncRevision, validateSyncOperation } from './syncProtocol.mjs'

const id = () => randomBytes(16).toString('hex')
const stamp = () => new Date().toISOString()
const identity = change => `${change.entity}/${change.entityId}`
const entities = { tasks: '事项', areas: '分类', events: '日历活动', availability: '可安排时间', assignments: '安排', planner: '课表与日程', goals: '余时目标', completions: '完成记录' }
const fields = { title: '标题', notes: '备注', due: '截止时间', startAt: '开始时间', estimateMin: '预计用时', status: '完成状态', blocks: '任务时段', routines: '每周安排', dayExceptions: '日期调整', dayOverrides: '单日课表', dayEvents: '单日活动', record: '整条记录' }
const summary = changes => Object.entries(changes.reduce((counts, change) => { const label = entities[change.entity]; counts[label] = (counts[label] ?? 0) + 1; return counts }, {})).map(([label, count]) => `${label} ${count} 项`).join('、')

/** Private SQLite journal. Business writes and capture() share the caller's transaction. */
export function createSyncStore({ db, transaction, snapshot, apply, baseline = () => ({}) }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_outbox (operationId TEXT PRIMARY KEY, sequence INTEGER UNIQUE NOT NULL, document TEXT NOT NULL, exported INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sync_seen (operationId TEXT PRIMARY KEY, deviceId TEXT NOT NULL, sequence INTEGER NOT NULL, digest TEXT NOT NULL, UNIQUE(deviceId,sequence));
    CREATE TABLE IF NOT EXISTS sync_heads (deviceId TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_pending (operationId TEXT PRIMARY KEY, deviceId TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL, reason TEXT NOT NULL, UNIQUE(deviceId,sequence));
    CREATE TABLE IF NOT EXISTS sync_tombstones (identity TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sync_receipts (operationId TEXT PRIMARY KEY, deviceId TEXT NOT NULL, createdAt TEXT NOT NULL, receivedAt TEXT NOT NULL, outcome TEXT NOT NULL, summary TEXT NOT NULL);
  `)
  let suppress = false
  const get = key => { const row = db.prepare('SELECT value FROM sync_meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : null }
  const set = (key, value) => db.prepare('INSERT OR REPLACE INTO sync_meta VALUES(?,?)').run(key, JSON.stringify(value))
  const isolated = fn => { const previous = suppress; suppress = true; try { return transaction(fn) } finally { suppress = previous } }
  const config = () => get('config')
  function receipt(operation, outcome) {
    db.prepare('INSERT INTO sync_receipts VALUES(?,?,?,?,?,?)').run(operation.operationId, operation.deviceId, operation.createdAt, stamp(), outcome, summary(operation.after.changes))
  }
  const changesBetween = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => {
    const old = before[key] ?? null, next = after[key] ?? null
    if (equal(old, next) && !(Object.hasOwn(after, key) && !Object.hasOwn(before, key) && next === null)) return []
    const slash = key.indexOf('/')
    return [{ entity: key.slice(0, slash), entityId: key.slice(slash + 1), before: old, after: next, baseRevision: syncRevision(old) }]
  })
  function append(changes) {
    if (!changes.length) return
    const cfg = config(), sequence = (get('sequence') ?? 0) + 1, operationId = id()
    const operation = { schema: 1, groupId: cfg.groupId, operationId, deviceId: cfg.deviceId, sequence,
      entity: 'transaction', entityId: operationId, type: 'put', baseRevision: null,
      before: null, after: { changes }, createdAt: stamp() }
    validateSyncOperation(operation)
    db.prepare('INSERT INTO sync_outbox(operationId,sequence,document) VALUES(?,?,?)').run(operationId, sequence, JSON.stringify(operation))
    db.prepare('INSERT INTO sync_seen VALUES(?,?,?,?)').run(operationId, cfg.deviceId, sequence, syncRevision(operation))
    set('sequence', sequence)
    receipt(operation, 'local')
    for (const change of changes) if (change.after === null) db.prepare('INSERT OR IGNORE INTO sync_tombstones VALUES(?)').run(identity(change))
  }
  const begin = () => !suppress && config() ? snapshot() : null
  const capture = before => { if (before !== null && !suppress && config()) append(changesBetween(before, snapshot())) }
  function configure(value) {
    return isolated(() => {
      if (config()) throw new Error('请先断开旧同步组，再加入或建立新组')
      set('config', { ...value, deviceId: id(), paused: false })
      set('sequence', 0)
      append(changesBetween(baseline(), snapshot()))
      return config()
    })
  }
  function disconnect() {
    return isolated(() => {
      for (const table of ['sync_meta', 'sync_outbox', 'sync_seen', 'sync_heads', 'sync_pending', 'sync_tombstones', 'sync_receipts']) db.exec(`DELETE FROM ${table}`)
    })
  }
  function receive(operation, choice) {
    validateSyncOperation(operation)
    if (operation.entity !== 'transaction' || operation.groupId !== config()?.groupId) throw new Error('同步组不匹配')
    return isolated(() => {
      const digest = syncRevision(operation)
      const seen = db.prepare('SELECT * FROM sync_seen WHERE operationId=? OR (deviceId=? AND sequence=?)').get(operation.operationId, operation.deviceId, operation.sequence)
      if (seen) {
        if (seen.operationId !== operation.operationId || seen.digest !== digest) throw new Error('同一操作或序号的内容发生变化')
        return 'duplicate'
      }
      if (operation.deviceId === config().deviceId) throw new Error('本设备操作记录缺失，请重新建立同步组')
      const pending = db.prepare('SELECT * FROM sync_pending WHERE operationId=? OR (deviceId=? AND sequence=?)').get(operation.operationId, operation.deviceId, operation.sequence)
      if (pending && (pending.operationId !== operation.operationId || syncRevision(JSON.parse(pending.document)) !== digest)) throw new Error('待处理操作的内容发生变化')
      const sequence = db.prepare('SELECT sequence FROM sync_heads WHERE deviceId=?').get(operation.deviceId)?.sequence ?? 0
      const defer = reason => {
        db.prepare('INSERT INTO sync_pending VALUES(?,?,?,?,?) ON CONFLICT(operationId) DO UPDATE SET reason=excluded.reason')
          .run(operation.operationId, operation.deviceId, operation.sequence, JSON.stringify(operation), reason)
        return 'pending'
      }
      if (operation.sequence !== sequence + 1) return defer(`等待此设备的第 ${sequence + 1} 条操作`)
      const current = snapshot(), merged = [], conflicts = []
      for (const change of operation.after.changes) {
        const key = identity(change), local = current[key] ?? null
        const tombstone = db.prepare('SELECT 1 FROM sync_tombstones WHERE identity=?').get(key)
        if (tombstone && change.after !== null && local === null) { conflicts.push(`${key}：已删除，不能恢复旧副本`); continue }
        const result = mergeSyncDocument(change.before, change.after, local)
        if (result.conflicts.length) conflicts.push(`${entities[change.entity]}${local?.title ? `「${local.title.slice(0, 80)}」` : ''}：${result.conflicts.map(field => fields[field] ?? field).join('、')} 同时修改`)
        let selected = result.value
        if (choice === 'remote') {
          selected = change.after
          if (change.before && change.after && local) {
            selected = { ...local }
            for (const field of new Set([...Object.keys(change.before), ...Object.keys(change.after)])) {
              if (equal(change.before[field], change.after[field])) continue
              if (Object.hasOwn(change.after, field)) Object.defineProperty(selected, field, { value: change.after[field], writable: true, configurable: true, enumerable: true })
              else delete selected[field]
            }
          }
        }
        merged.push({ ...change, before: local, after: selected })
      }
      if (conflicts.length && !choice) return defer(conflicts.join('；').slice(0, 2000))
      // Tombstones are never bypassed by a remote preference.
      if (choice === 'remote' && conflicts.some(item => item.includes('已删除'))) return defer(conflicts.join('；'))
      if (choice !== 'local') {
        try { transaction(() => apply(merged)) }
        catch (error) { return defer(`日程或数据校验未通过：${error.message}`.slice(0, 2000)) }
      } else {
        // Publish the explicit local decision so the origin can converge too.
        append(operation.after.changes.map(change => ({ ...change, before: change.after,
          after: current[identity(change)] ?? null, baseRevision: syncRevision(change.after) })).filter(change => !equal(change.before, change.after)))
      }
      for (const change of merged) if (choice !== 'local' && change.after === null) db.prepare('INSERT OR IGNORE INTO sync_tombstones VALUES(?)').run(identity(change))
      db.prepare('INSERT INTO sync_seen VALUES(?,?,?,?)').run(operation.operationId, operation.deviceId, operation.sequence, digest)
      db.prepare('INSERT OR REPLACE INTO sync_heads VALUES(?,?)').run(operation.deviceId, operation.sequence)
      db.prepare('DELETE FROM sync_pending WHERE operationId=?').run(operation.operationId)
      receipt(operation, choice === 'local' ? 'kept-local' : 'applied')
      return choice === 'local' ? 'kept-local' : 'applied'
    })
  }
  return {
    begin, capture, config, configure, disconnect, receive,
    checked: () => isolated(() => set('lastCheckedAt', stamp())),
    pause: paused => isolated(() => { const cfg = config(); if (!cfg) throw new Error('尚未设置同步'); set('config', { ...cfg, paused }) }),
    outbox: () => db.prepare('SELECT operationId,document FROM sync_outbox WHERE exported=0 ORDER BY sequence').all().map(row => JSON.parse(row.document)),
    exported: operationId => isolated(() => db.prepare('UPDATE sync_outbox SET exported=1 WHERE operationId=?').run(operationId)),
    pending: () => db.prepare('SELECT * FROM sync_pending ORDER BY deviceId,sequence').all(),
    resolve: (operationId, choice) => { const row = db.prepare('SELECT document FROM sync_pending WHERE operationId=?').get(operationId); if (!row) throw new Error('待处理操作已不存在'); return receive(JSON.parse(row.document), choice) },
    status: () => ({ configured: Boolean(config()), ...config(), lastCheckedAt: get('lastCheckedAt'), pendingExports: db.prepare('SELECT COUNT(*) AS count FROM sync_outbox WHERE exported=0').get().count,
      receipts: db.prepare('SELECT * FROM sync_receipts ORDER BY rowid DESC LIMIT 20').all(),
      conflicts: db.prepare('SELECT operationId,deviceId,sequence,reason FROM sync_pending ORDER BY deviceId,sequence LIMIT 100').all() }),
  }
}
