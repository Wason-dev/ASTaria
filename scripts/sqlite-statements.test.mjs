import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedSqliteDriver } from '../server/sqliteStatements.mjs'

function fixture(t, limit = 128, path = ':memory:') {
  const db = new DatabaseSync(path), prepared = []
  const driver = cachedSqliteDriver({ exec: sql => db.exec(sql), prepare(sql) { prepared.push(sql); return db.prepare(sql) } }, limit)
  t.after(() => { driver.clear(); db.close() })
  return { db, driver, prepared }
}
test('cached prepared SQL reuses compilation but always reads current writes, commits and rollbacks', t => {
  const { driver, prepared } = fixture(t)
  driver.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)')
  for (let i = 0; i < 30; i++) {
    driver.exec('BEGIN IMMEDIATE')
    driver.prepare('INSERT OR REPLACE INTO items VALUES(?,?)').run(1, String(i))
    driver.exec('COMMIT')
    assert.equal(driver.prepare('SELECT value FROM items WHERE id=?').get(1).value, String(i))
  }
  assert.equal(prepared.length, 2, '60 calls compile exactly two SQL statements')
  driver.exec('BEGIN'); driver.exec('SAVEPOINT nested')
  driver.prepare('INSERT OR REPLACE INTO items VALUES(?,?)').run(1, 'rollback')
  driver.exec('ROLLBACK TO SAVEPOINT nested'); driver.exec('RELEASE SAVEPOINT nested'); driver.exec('COMMIT')
  assert.equal(driver.prepare('SELECT value FROM items WHERE id=?').get(1).value, '29')
})
test('repeated positional/named binding calls do not leak missing previous parameters or returned row edits', t => {
  const { driver } = fixture(t)
  const positional = 'SELECT ? AS x, ? AS y', named = 'SELECT :x AS x, :y AS y'
  assert.equal(driver.prepare(positional).get(1, 2).y, 2)
  assert.equal(driver.prepare(positional).get(3).y, null)
  assert.equal(driver.prepare(positional).get().x, null)
  const row = driver.prepare(named).get({ x: 4, y: 5 }); row.x = 'changed'
  assert.equal(driver.prepare(named).get({ x: 6 }).y, null)
  assert.equal(driver.prepare(named).get({ x: 6 }).x, 6)
})
test('statement eviction is bounded, schema changes invalidate it and failed prepare never enters it', t => {
  const { driver, prepared } = fixture(t, 2)
  const first = driver.prepare('SELECT 1')
  driver.prepare('SELECT 2'); assert.equal(driver.prepare('SELECT 1'), first)
  driver.prepare('SELECT 3'); driver.prepare('SELECT 2')
  assert.equal(prepared.filter(sql => sql === 'SELECT 2').length, 2)
  assert.throws(() => driver.prepare('SELECT * FROM missing'))
  driver.exec('CREATE TABLE missing(value TEXT)')
  assert.deepEqual(driver.prepare('SELECT * FROM missing').all(), [])
  driver.exec('ALTER TABLE missing ADD COLUMN other INTEGER')
  assert.deepEqual(driver.prepare('SELECT * FROM missing').columns().map(c => c.name), ['value', 'other'])
  driver.clear(); assert.notEqual(driver.prepare('SELECT 1'), first)
})
test('cached statements see another connection commit without any result cache or revision assumption', t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-statements-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, 'synthetic.sqlite'), { driver } = fixture(t, 128, file)
  driver.exec('PRAGMA journal_mode=WAL; CREATE TABLE state(value TEXT); INSERT INTO state VALUES(\'before\')')
  assert.equal(driver.prepare('SELECT value FROM state').get().value, 'before')
  const other = new DatabaseSync(file)
  try { other.prepare('UPDATE state SET value=?').run('after') } finally { other.close() }
  assert.equal(driver.prepare('SELECT value FROM state').get().value, 'after')
})
