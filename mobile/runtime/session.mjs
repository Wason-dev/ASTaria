import { createDatabaseCore } from '../../server/databaseCore.mjs'
import { createSyncStore } from '../../server/syncStore.mjs'
import { createBackupStore, validateCompanionState } from '../../server/backup.mjs'
import { sha256Hex } from '../../server/portable.mjs'
import { knownKeys, ValidationError } from '../../server/validation.mjs'
import { sqliteDriver } from './sqlite.mjs'
import { checkedSnapshot, serialCalls, MAX_MOBILE_DATABASE_BYTES } from './snapshots.mjs'
import { createMobileService } from './service.mjs'
import { abortSignalAny } from '../../server/abortSignal.mjs'

/** The acknowledged snapshot is the rollback point. Even GET routes may
 * initialize durable preferences, so dirty detection surrounds every call. */
export async function createMobileSession({ SQL, storage, serviceOptions = {} }) {
  let raw, driver, db, service, acknowledged, hash, savedRevision, storageFailed = false
  const serialized = serialCalls(), active = new Set()
  function open(bytes) {
    raw = bytes ? new SQL.Database(checkedSnapshot(bytes)) : new SQL.Database()
    driver = sqliteDriver(raw)
    if (driver.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') { raw.close(); throw new Error('本机数据库检查失败，原数据已保留') }
    try {
      let alive = false
      db = createDatabaseCore(driver, { ownerPid: 1, processAlive: () => alive, createSyncStore, createBackupStore, validateCompanionState })
      db.recoverAbandonedTurns(); alive = true
      service = createMobileService({ ...serviceOptions, db })
    } catch (error) { raw.close(); throw error }
  }
  const persist = () => serialized(async () => {
    if (storageFailed) throw new Error('本机存储尚未恢复，请重启后重试')
    if (driver.revision === savedRevision) return
    // A later mutation may arrive while the native write is in flight. Only
    // acknowledge the revision actually included in this exported snapshot.
    const snapshotRevision = driver.revision
    let bytes, nextHash, overCapacity = false
    try {
      bytes = driver.exportSnapshot()
      if (bytes.byteLength > MAX_MOBILE_DATABASE_BYTES) {
        overCapacity = true
        throw new ValidationError('本机数据超过 64 MiB 保存上限，本次操作未保存；已恢复之前的记录，仍可查看或导出', 413)
      }
      checkedSnapshot(bytes); nextHash = sha256Hex(bytes)
      if (nextHash === hash) { savedRevision = snapshotRevision; return }
      await storage.save(bytes)
    } catch (error) {
      storageFailed = !overCapacity
      for (const controller of active) controller.abort(error instanceof Error ? error : new Error('本机存储未能保存'))
      raw.close()
      if (acknowledged) { open(acknowledged); savedRevision = driver.revision }
      if (overCapacity && acknowledged) throw error
      throw new Error('本机数据未能保存，此次操作没有确认成功；原数据已保留，请检查存储空间并重启')
    }
    acknowledged = bytes; hash = nextHash; savedRevision = snapshotRevision
  })
  const saved = await storage.load()
  if (saved) { acknowledged = checkedSnapshot(saved); hash = sha256Hex(saved) }
  open(saved)
  // Existing-schema DDL and transaction boundaries are not data changes.
  // Actual migrations or abandoned-turn recovery still increment revision.
  if (saved && driver.revision === 0) savedRevision = 0
  await persist()
  return {
    call(path, input, options) {
      return (async () => {
        if (storageFailed) throw new Error('本机存储尚未恢复，请重启后重试；未确认的操作没有保存')
        const controller = new AbortController(); active.add(controller)
        const signal = options?.signal ? abortSignalAny([options.signal, controller.signal]) : controller.signal
        let value, issue, streamIssue
        let streamWrites = Promise.resolve()
        try {
          if (path === '/api/platform/reminder-snapshot') value = service.reminderSnapshot()
          else if (path === '/api/platform/reminders-enabled') {
            if (input !== undefined) {
              knownKeys(input, ['enabled'])
              if (typeof input.enabled !== 'boolean') throw new ValidationError('提醒开关状态不正确')
              db.setPreference('mobile-reminders-enabled', input.enabled)
            }
            value = { enabled: db.getPreference('mobile-reminders-enabled') === true }
          } else {
            const startStream = options?.startStream ? () => {
              const send = options.startStream()
              return event => {
                streamWrites = streamWrites.then(async () => {
                  if (streamIssue) return
                  if (event.type === 'activity' || event.type === 'operations') await persist()
                  if (!storageFailed && !signal.aborted) send(event)
                }).catch(error => { streamIssue ??= error })
              }
            } : undefined
            value = await service.dispatch(path, input, { ...options, signal, startStream })
          }
        }
        catch (error) { issue = error }
        await streamWrites
        try { await persist() }
        catch (error) {
          active.delete(controller)
          // A failed durable save has already frozen and restored the session.
          if (error instanceof ValidationError) throw error
          throw new Error('本机数据未能保存，此次操作没有确认成功；原数据已保留，请检查存储空间并重启')
        }
        active.delete(controller)
        if (streamIssue) throw streamIssue
        if (issue) throw issue
        signal.throwIfAborted()
        return value
      })()
    },
    flush: persist,
    close: async () => { db.close(); await persist(); raw.close() },
  }
}
