import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync, existsSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createDatabaseCore } from './databaseCore.mjs'
import { createSyncStore } from './syncStore.mjs'
import { createBackupStore, validateCompanionState } from './backup.mjs'
import { text } from './validation.mjs'
import { cachedSqliteDriver } from './sqliteStatements.mjs'

const lockToken = /^sqlite-lock:([a-f0-9-]{36})$/u
const localOwners = new Set()

// Old releases have no owner lock. A live PID alone is not evidence that it
// owns this database. On Unix, check the specific process's open DB handle.
// Probe failures are unknown, never permission to interrupt a live service.
function legacyOwnerAlive(turn, filename) {
  const pid = turn.ownerPid
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  let denied = false
  try { process.kill(pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code !== 'EPERM') return null
    denied = true
  }
  if (filename === ':memory:') return false
  if (process.platform === 'win32') return null
  const identity = spawnSync('ps', ['-p', String(pid), '-o', 'uid=', '-o', 'comm='], { encoding: 'utf8', timeout: 2000 })
  const processInfo = identity.status === 0 && /^\s*(\d+)\s+(.+?)\s*$/u.exec(identity.stdout)
  // macOS PID 1 is the system launchd, never an ASTaria runtime. Do not make
  // that assumption on Linux where PID 1 may be a real service in a container.
  if (process.platform === 'darwin' && pid === 1 && processInfo?.[2] === '/sbin/launchd') return false
  // An inaccessible/different-user process might really have the DB open.
  // Its missing lsof output cannot establish abandonment.
  if (denied || !processInfo || Number(processInfo[1]) !== process.getuid()) return null
  const probe = spawnSync('lsof', ['-a', '-p', String(pid), '-Fn', '--', filename], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 })
  if (probe.error || probe.signal || probe.stderr?.trim()) return null
  if (probe.status === 0) return true
  return probe.status === 1 && !probe.stdout.trim() ? false : null
}

/** An OS-held SQLite lock is released on crash, including PID reuse, sleep or
 * a stalled event loop. Each connection has its own lock, outside the business
 * DB/backup. No heartbeat timer or expiry can steal an active request. */
function createOwner(filename) {
  const token = `sqlite-lock:${randomUUID()}`
  let lock, directory, lockfile
  if (filename !== ':memory:') {
    filename = realpathSync(filename)
    directory = `${filename}.owners`
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    lockfile = join(directory, `${token.slice('sqlite-lock:'.length)}.sqlite`)
    lock = new DatabaseSync(lockfile)
    try {
      chmodSync(lockfile, 0o600)
      lock.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE')
    } catch (error) { lock.close(); throw error }
  }
  localOwners.add(token)
  return {
    token,
    alive(turn) {
      if (localOwners.has(turn.ownerToken)) return true
      const match = typeof turn.ownerToken === 'string' && lockToken.exec(turn.ownerToken)
      if (!match) return legacyOwnerAlive(turn, filename)
      if (!directory) return false
      const path = join(directory, `${match[1]}.sqlite`)
      if (!existsSync(path)) return false
      let probe, abandoned = false
      try {
        probe = new DatabaseSync(path)
        probe.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK')
        abandoned = true
        return false
      } catch (error) {
        // SQLite BUSY/LOCKED is positive evidence of a held lock. Other I/O
        // errors are deliberately unknown rather than a false recovery.
        return [5, 6].includes(error.errcode & 255) ? true : null
      } finally {
        probe?.close()
        if (abandoned) { try { unlinkSync(path) } catch { /* Already cleaned by a peer. */ } }
      }
    },
    close() {
      localOwners.delete(token)
      lock?.close()
      if (lockfile) { try { unlinkSync(lockfile) } catch { /* A stale unlocked file is harmless. */ } }
    },
  }
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
  let owner
  try {
    if (db.location() !== null) chmodSync(filename, 0o600)
    owner = createOwner(filename)
    const core = createDatabaseCore(driver, { ownerAlive: owner.alive, ownerToken: owner.token, ownerPid: process.pid, createSyncStore, createBackupStore, validateCompanionState })
    let closed = false
    return { ...core, close() { if (closed) return; try { core.close() } finally { closed = true; driver.clear(); db.close(); owner.close() } } }
  } catch (error) { driver.clear(); db.close(); owner?.close(); throw error }
}
