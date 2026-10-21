// Cache compiled SQL, never rows or query results. Every invocation still
// reads the current transaction, including writes from other connections.
export function cachedSqliteDriver(database, limit = 128) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512) throw new RangeError('Invalid statement cache limit')
  const statements = new Map()
  const transaction = /^\s*(?:(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?|COMMIT|END|ROLLBACK)(?:\s+TRANSACTION)?|(?:SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|ROLLBACK\s+TO(?:\s+SAVEPOINT)?)\s+[A-Za-z_][A-Za-z_0-9]*)\s*;?\s*$/iu
  return {
    exec(sql) {
      // Schema/connection changes may alter compiled statements. Transactions
      // keep them reusable; do not attempt to classify arbitrary SQL as reads.
      if (!transaction.test(sql)) statements.clear()
      return database.exec(sql)
    },
    prepare(sql) {
      let statement = statements.get(sql)
      if (statement) statements.delete(sql)
      else statement = database.prepare(sql)
      statements.set(sql, statement)
      if (statements.size > limit) statements.delete(statements.keys().next().value)
      return statement
    },
    clear() { statements.clear() },
  }
}
