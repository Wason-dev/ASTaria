/** A synchronous SQLite contract for the shared business rules. The whole
 * runtime lives in a worker; async snapshot persistence surrounds each call. */
export function sqliteDriver(database) {
  let revision = 0
  const value = sql => database.exec(sql)[0]?.values[0]?.[0] ?? 0
  const stamp = () => `${value('SELECT total_changes()')}:${value('PRAGMA schema_version')}:${value('PRAGMA user_version')}`
  const transactionOnly = sql => sql.split(';').filter(part => part.trim()).every(part => /^(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+TRANSACTION)?|(?:COMMIT|END)(?:\s+TRANSACTION)?|ROLLBACK(?:\s+TRANSACTION)?(?:\s+TO(?:\s+SAVEPOINT)?\s+[\w]+)?|(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?)\s+[\w]+)$/iu.test(part.trim()))
  function statement(sql) {
    const read = (values, single) => {
      const prepared = database.prepare(sql)
      try {
        prepared.bind(values)
        const rows = []
        while (prepared.step()) {
          rows.push(prepared.getAsObject())
          if (single) break
        }
        return single ? rows[0] : rows
      } finally { prepared.free() }
    }
    return {
      get: (...values) => read(values, true),
      all: (...values) => read(values, false),
      run(...values) {
        database.run(sql, values)
        const changes = database.getRowsModified()
        if (changes) revision++
        return { changes, lastInsertRowid: database.exec('SELECT last_insert_rowid()')[0]?.values[0][0] ?? 0 }
      },
    }
  }
  return {
    prepare: statement,
    exec(sql) {
      if (transactionOnly(sql)) { database.run(sql); return }
      const before = stamp()
      database.run(sql)
      if (stamp() !== before) revision++
    },
    exportSnapshot() {
      // sql.js closes/reopens its connection during export, resetting these
      // connection invariants. Restoring them is not a persistent mutation.
      const foreignKeys = value('PRAGMA foreign_keys'), timeout = value('PRAGMA busy_timeout')
      try { return database.export() }
      finally { database.run(`PRAGMA foreign_keys = ${Number(foreignKeys)}; PRAGMA busy_timeout = ${Number(timeout)}`) }
    },
    close: () => database.close(), get revision() { return revision },
  }
}
