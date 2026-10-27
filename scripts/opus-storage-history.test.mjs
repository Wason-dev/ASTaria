import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import initSqlJs from 'sql.js'
import { createDatabaseCore } from '../server/databaseCore.mjs'
import { createBackupStore, validateCompanionState } from '../server/backup.mjs'
import { cachedSqliteDriver } from '../server/sqliteStatements.mjs'
import { sqliteDriver } from '../mobile/runtime/sqlite.mjs'
const SQL = await initSqlJs()

for (const engine of ['node:sqlite', 'sql.js']) {
  test(`${engine}: after reads earliest bounded history pages without skipping the middle`, t => {
    const raw = engine === 'node:sqlite' ? new DatabaseSync(':memory:') : new SQL.Database()
    const driver = engine === 'node:sqlite' ? cachedSqliteDriver(raw) : sqliteDriver(raw)
    const db = createDatabaseCore(driver, { createBackupStore, validateCompanionState })
    t.after(() => { db.close(); driver.clear?.(); raw.close() })
    const messages = []
    for (let i = 0; i < 9; i++) {
      messages.push(db.appendMessage({ id: `synthetic-${i}`, conversationId: 'main', role: 'user', content: `synthetic history ${i}` }))
      db.appendMessage({ conversationId: 'other', role: 'user', content: 'other conversation' })
    }
    db.retractMessage(messages[4].id)
    const ids = rows => rows.map(row => row.id)
    const query = options => ids(db.listMessages('main', options))
    assert.deepEqual(query({ limit: 3 }), ids(messages.slice(-3)))
    assert.deepEqual(query({ before: messages[7].seq, limit: 3 }), ids(messages.slice(4, 7)))
    assert.deepEqual(query({ after: 0, limit: 3 }), ids(messages.slice(0, 3)))
    assert.deepEqual(query({ after: messages[1].seq, limit: 3 }), ids(messages.slice(2, 5)))
    const before = messages[8].seq
    assert.deepEqual(query({ after: messages[1].seq, before, limit: 2 }), ids(messages.slice(2, 4)))
    assert.deepEqual(query({ after: messages[1].seq, before, limit: 4, forContext: true }), ids([messages[2], messages[3], messages[5], messages[6]]))
    for (const forContext of [false, true]) {
      const seen = []; let after = messages[1].seq
      for (let page = 0; page < 8; page++) {
        const rows = db.listMessages('main', { after, before, limit: 2, forContext })
        if (!rows.length) break
        assert.ok(rows.every(row => row.seq > after && row.seq < before))
        seen.push(...ids(rows)); after = rows.at(-1).seq
      }
      assert.deepEqual(seen, ids(messages.slice(2, 8).filter((_, index) => !forContext || index !== 2)))
      assert.equal(new Set(seen).size, seen.length)
    }
    assert.deepEqual(query({ after: before, before }), [])
    assert.deepEqual(query({ after: before + 1, before }), [])
    assert.deepEqual(query({ after: Number.MAX_SAFE_INTEGER }), [])
    for (const after of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, true, 1n, {}]) {
      assert.throws(() => db.listMessages('main', { after }), /非负安全整数/u)
    }
    assert.deepEqual(query({ after: undefined, limit: 3 }), ids(messages.slice(-3)))
  })
}
