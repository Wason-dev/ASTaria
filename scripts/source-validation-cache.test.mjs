import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../server/database.mjs'
import initSqlJs from 'sql.js'
import { createDatabaseCore } from '../server/databaseCore.mjs'
import { createBackupStore, validateCompanionState } from '../server/backup.mjs'
import { sqliteDriver } from '../mobile/runtime/sqlite.mjs'

test('source validation reuse observes local retraction, mutated lists and external connection changes', () => {
  const directory=mkdtempSync(join(tmpdir(),'astaria-source-validation-')),path=join(directory,'test.sqlite')
  const db=createDatabase(path),external=new DatabaseSync(path)
  try {
    const first=db.appendMessage({conversationId:'main',requestId:'first',role:'user',content:'Synthetic A'})
    const second=db.appendMessage({conversationId:'main',requestId:'second',role:'user',content:'Synthetic B'})
    const sources=[first.id,second.id]
    db.assertTurnWritable(null,sources);db.assertTurnWritable(null,sources)
    sources.push('missing-source')
    assert.throws(()=>db.assertTurnWritable(null,sources),/撤回或删除/)
    sources.pop();db.assertTurnWritable(null,sources)
    external.prepare("UPDATE messages SET document=json_set(document,'$.contextRetractedAt','2026-10-24T00:00:00Z') WHERE id=?").run(second.id)
    assert.throws(()=>db.assertTurnWritable(null,sources),/撤回或删除/)
    db.assertTurnWritable(null,[first.id]);db.retractMessage(first.id)
    assert.throws(()=>db.assertTurnWritable(null,[first.id]),/撤回或删除/)
  } finally {external.close();db.close();rmSync(directory,{recursive:true,force:true})}
})

test('mobile snapshot exports cannot make a pre-retraction cache valid again', async () => {
  const SQL=await initSqlJs(),raw=new SQL.Database(),driver=sqliteDriver(raw)
  const db=createDatabaseCore(driver,{createBackupStore,validateCompanionState})
  try {
    const message=db.appendMessage({conversationId:'main',requestId:'first',role:'user',content:'Synthetic snapshot source'})
    driver.exportSnapshot();db.assertTurnWritable(null,[message.id])
    db.retractMessage(message.id);driver.exportSnapshot()
    assert.throws(()=>db.assertTurnWritable(null,[message.id]),/撤回或删除/)
  } finally {db.close();raw.close()}
})
