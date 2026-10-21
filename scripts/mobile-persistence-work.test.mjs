import test from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import { createMobileSession } from '../mobile/runtime/session.mjs'
import { sqliteDriver } from '../mobile/runtime/sqlite.mjs'
import { MAX_MOBILE_DATABASE_BYTES } from '../mobile/runtime/snapshots.mjs'
const SQL=await initSqlJs()
function fixture(){
  let bytes,exports=0,saves=0,tooLarge=false
  class Database extends SQL.Database { export(){exports++;const value=super.export();if(!tooLarge)return value;const large=new Uint8Array(MAX_MOBILE_DATABASE_BYTES+1);large.set(value);return large} }
  return {SQL:{Database},storage:{load:async()=>bytes?.slice(),save:async next=>{saves++;bytes=next.slice()}},counts:()=>({exports,saves}),clear:()=>{exports=0;saves=0},oversize:value=>{tooLarge=value}}
}
test('transaction boundaries and unchanged DDL do not dirty reads; real schema/data changes do',()=>{
  const raw=new SQL.Database(),driver=sqliteDriver(raw)
  driver.exec('CREATE TABLE data (id INTEGER)');const created=driver.revision
  driver.exec('BEGIN IMMEDIATE');driver.exec('COMMIT');driver.exec('CREATE TABLE IF NOT EXISTS data (id INTEGER)')
  assert.equal(driver.revision,created)
  driver.exec('BEGIN');driver.exec('SAVEPOINT astaria_0');driver.exec('ROLLBACK TO SAVEPOINT astaria_0; RELEASE SAVEPOINT astaria_0');driver.exec('END TRANSACTION')
  assert.equal(driver.revision,created)
  driver.exec('PRAGMA user_version = 2');assert.equal(driver.revision,created+1)
  driver.exec('PRAGMA user_version = 2');assert.equal(driver.revision,created+1)
  driver.exec('INSERT INTO data VALUES (1)');assert.equal(driver.revision,created+2)
  driver.exec('BEGIN');driver.prepare('INSERT INTO data VALUES (?)').run(2);driver.exec('ROLLBACK')
  assert.deepEqual(driver.prepare('SELECT * FROM data').all(),[{id:1}]);raw.close()
})
test('20 repeated read cycles export and save zero whole database snapshots',async()=>{
  const f=fixture(),session=await createMobileSession(f)
  await session.call('/api/conversation');await session.call('/api/areas');await session.call('/api/planner');f.clear()
  for(let i=0;i<20;i++)for(const path of ['/api/conversation','/api/areas','/api/planner','/api/tasks'])await session.call(path)
  assert.deepEqual(f.counts(),{exports:0,saves:0})
  await session.call('/api/tasks/create',{title:'真实变更仍保存'});assert.deepEqual(f.counts(),{exports:1,saves:1})
  await session.close()
})
test('opening the current acknowledged schema does not rewrite it; a real schema upgrade still saves',async()=>{
  const f=fixture(),session=await createMobileSession(f);await session.call('/api/conversation');await session.close();f.clear()
  const restored=await createMobileSession(f);assert.deepEqual(f.counts(),{exports:0,saves:0});await restored.close()
  const bytes=await f.storage.load(),old=new SQL.Database(bytes);old.run('PRAGMA user_version = 2');await f.storage.save(old.export());old.close();f.clear()
  const migrated=await createMobileSession(f);assert.deepEqual(f.counts(),{exports:1,saves:1});await migrated.close()
})
test('export restores connection foreign keys and timeout without a dirty revision',()=>{
  const raw=new SQL.Database(),driver=sqliteDriver(raw)
  driver.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;CREATE TABLE parent(id TEXT PRIMARY KEY);CREATE TABLE child(id TEXT REFERENCES parent(id));')
  const before=driver.revision;driver.exportSnapshot()
  assert.equal(driver.revision,before)
  assert.equal(driver.prepare('PRAGMA foreign_keys').get().foreign_keys,1)
  assert.equal(driver.prepare('PRAGMA busy_timeout').get().timeout,5000)
  assert.throws(()=>driver.prepare('INSERT INTO child VALUES (?)').run('orphan'),/FOREIGN KEY/)
  raw.close()
})
test('an oversized export rolls back only unacknowledged data and keeps reads and subsequent writes usable',async()=>{
  const f=fixture(),session=await createMobileSession(f)
  const task=await session.call('/api/tasks/create',{title:'已确认'});f.oversize(true)
  await assert.rejects(session.call('/api/tasks/create',{title:'不能伪报保存'}),/64 MiB/)
  f.oversize(false)
  assert.deepEqual((await session.call('/api/tasks')).map(task=>task.title),['已确认'])
  await session.call('/api/tasks/update',{id:task.id,patch:{title:'恢复后可继续'},expectedUpdatedAt:task.updatedAt})
  const restored=await createMobileSession(f)
  assert.deepEqual((await restored.call('/api/tasks')).map(task=>task.title),['恢复后可继续'])
  await restored.close();await session.close()
})
