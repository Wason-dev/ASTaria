import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createDatabaseCore } from './databaseCore.mjs'
import { createSyncStore } from './syncStore.mjs'
import { createBackupStore, validateCompanionState } from './backup.mjs'
import { text } from './validation.mjs'
import { cachedSqliteDriver } from './sqliteStatements.mjs'

const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/** Opening is explicit; importing this module never touches a user's data. */
export function createDatabase(filename) {
  filename = text(filename, '数据库路径', 4096)
  if (filename !== ':memory:') {
    const directory = dirname(filename)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
  }
  const db = new DatabaseSync(filename)
  const driver = cachedSqliteDriver(db)
  try {
    if (db.location() !== null) chmodSync(filename, 0o600)
    const core = createDatabaseCore(driver, { processAlive, ownerPid: process.pid, createSyncStore, createBackupStore, validateCompanionState })
    let closed = false
    return { ...core, close() { if (closed) return; try { core.close() } finally { closed = true; driver.clear(); db.close() } } }
  } catch (error) { driver.clear(); db.close(); throw error }
}
