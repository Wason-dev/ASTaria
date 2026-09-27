import { localApi } from '../xixi/api'

const MIGRATION_KEY = 'astaria-sqlite-migration-v1'
export const LOCAL_DATA_CHANGE = 'astaria-local-data-change'
let migration: Promise<void> | null = null

/** Read the previous business databases only. API settings and keys are excluded. */
export function ensureLocalMigration(): Promise<void> {
  if (!migration) migration = migrate().catch(error => { migration = null; throw error })
  return migration
}

export function notifyLocalDataChange() { window.dispatchEvent(new Event(LOCAL_DATA_CHANGE)) }

async function migrate() {
  try { if (localStorage.getItem(MIGRATION_KEY) === 'complete') return } catch { /* Import is idempotent when browser storage is unavailable. */ }
  const [tasks, events, schedule] = await Promise.all([
    readDatabase('astaria-local', ['tasks', 'areas']),
    readDatabase('astaria-calendar', ['events']),
    readDatabase('astaria-schedule', ['availability', 'assignments']),
  ])
  await localApi('/migration', {
    tasks: tasks.tasks, areas: tasks.areas, events: events.events,
    availability: schedule.availability, assignments: schedule.assignments,
  })
  // Mark only after SQLite has committed. Keep source databases intact.
  try { localStorage.setItem(MIGRATION_KEY, 'complete') } catch { /* A later import safely retries insert-ignore. */ }
}

async function readDatabase(name: string, tables: string[]): Promise<Record<string, unknown[]>> {
  const empty: Record<string, unknown[]> = Object.fromEntries(tables.map(table => [table, []]))
  if (!globalThis.indexedDB) return empty
  if (typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases()
    if (!databases.some(database => database.name === name)) return empty
  }
  const database = await new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(name)
    let absent = false
    request.onupgradeneeded = () => {
      // Older engines lack databases(); abort creation if this DB is absent.
      absent = true
      request.transaction?.abort()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => absent ? resolve(null) : reject(new Error('旧事项暂时无法读取，请重试，原数据仍保留'))
    request.onblocked = () => reject(new Error('请关闭其他 ASTaria 页面后重试迁移'))
  })
  if (!database) return empty
  try {
    const names = tables.filter(table => database.objectStoreNames.contains(table))
    if (!names.length) return empty
    return await new Promise<Record<string, unknown[]>>((resolve, reject) => {
      const result = { ...empty }
      const transaction = database.transaction(names, 'readonly')
      transaction.onerror = () => reject(new Error('旧事项暂时无法读取，原数据仍保留'))
      transaction.onabort = () => reject(new Error('旧事项读取中断，请重试'))
      transaction.oncomplete = () => resolve(result)
      for (const table of names) {
        const request = transaction.objectStore(table).getAll()
        request.onsuccess = () => { result[table] = request.result }
      }
    })
  } finally { database.close() }
}
