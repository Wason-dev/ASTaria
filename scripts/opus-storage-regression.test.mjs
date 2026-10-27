import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import initSqlJs from 'sql.js'
import { createDatabaseCore } from '../server/databaseCore.mjs'
import { createBackupStore, validateCompanionState } from '../server/backup.mjs'
import { createSyncStore } from '../server/syncStore.mjs'
import { sqliteDriver } from '../mobile/runtime/sqlite.mjs'
import { cachedSqliteDriver } from '../server/sqliteStatements.mjs'
import { summarizeChatAttachments, chatAttachmentsMatch } from '../server/chatAttachments.mjs'
import { serializeBackup, backupByteLength } from '../src/xixi/backupLimits.ts'

// All fixtures are synthetic. No default DB, settings, network or user files.
const SQL = await initSqlJs()
const MiB = 1024 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
const resign = backup => { backup.checksum = hash(JSON.stringify(backup.tables)); return backup }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOMatrCwMDAxAAGUAoAHaoBllxQ+i0AAAAASUVORK5CYII=', 'base64')
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0)
  return n >>> 0
})
function image(size = png.length, fill = 'p') {
  let bytes = png
  if (size > png.length) {
    const chunk = Buffer.alloc(size - png.length, fill)
    chunk.writeUInt32BE(chunk.length - 12); chunk.write('tEXt', 4); chunk.write('Padding\0', 8)
    let crc = 0xffffffff
    for (const byte of chunk.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
    bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
  }
  return { name: 'synthetic.png', mime: 'image/png', size: bytes.length, data: `data:image/png;base64,${bytes.toString('base64')}` }
}
function document() {
  const bytes = Buffer.from('%PDF-1.7\nsynthetic\n%%EOF')
  return { kind: 'document', name: 'synthetic.pdf', mime: 'application/pdf', size: bytes.length,
    data: `data:application/pdf;base64,${bytes.toString('base64')}`,
    document: { format: 'pdf', sections: [{ label: 'page 1', text: 'synthetic content' }], warnings: [] } }
}
const factories = { createBackupStore, createSyncStore, validateCompanionState }
function fixture(t, engine) {
  const raw = engine === 'node:sqlite' ? new DatabaseSync(':memory:') : new SQL.Database()
  const driver = engine === 'node:sqlite' ? cachedSqliteDriver(raw) : sqliteDriver(raw)
  let db = createDatabaseCore(driver, factories)
  t.after(() => { db.close(); driver.clear?.(); raw.close() })
  return { raw, driver, get db() { return db }, reopen() { db = createDatabaseCore(driver, factories); return db } }
}
const request = (attachments, requestId = 'request') => ({ requestId, conversationId: 'main', text: attachments ? '' : 'synthetic text', context: { timezone: 'UTC' }, ...(attachments ? { attachments } : {}) })
const finish = (db, id = 'request', status = 'completed') => db.finishTurn(id, { status, result: { requestId: id, conversationId: 'main', status } })
function replaceTurn(driver, id, mutate) {
  const turn = JSON.parse(driver.prepare('SELECT document FROM turns WHERE id=?').get(id).document)
  mutate(turn)
  driver.prepare('UPDATE turns SET document=? WHERE id=?').run(JSON.stringify(turn), id)
}

for (const engine of ['node:sqlite', 'sql.js']) {
  test(`${engine}: compact image/document identity, retries and forged hashes`, t => {
    const { db } = fixture(t, engine)
    for (const [index, attachment] of [image(256, 'p'), document()].entries()) {
      const input = request([attachment], `r${index}`), summary = summarizeChatAttachments(input.attachments)
      assert.equal(summary[0].sha256, hash(Buffer.from(attachment.data.split(',')[1], 'base64')))
      assert.equal(chatAttachmentsMatch(input.attachments, input.attachments), true)
      const first = db.beginTurn(input)
      assert.deepEqual(first.attachments, summary)
      assert.equal(JSON.stringify(first).includes('base64,'), false)
      assert.deepEqual(db.getMessage(first.userMessageId).attachments, input.attachments)
      assert.equal(db.beginTurn(input).claimed, false)
      db.updateTurnProgress(input.requestId, { phase: 'synthetic' })
      finish(db, input.requestId, 'failed')
      assert.equal(db.beginTurn(input).claimed, true)
      finish(db, input.requestId)
      assert.equal(db.beginTurn(input).claimed, false)
      assert.throws(() => db.beginTurn({ ...input, attachments: [{ ...attachment, name: 'changed' }] }), error => error.status === 409)
      assert.throws(() => db.beginTurn({ ...input, attachments: [{ ...attachment, sha256: summary[0].sha256 }] }))
      assert.throws(() => db.beginTurn({ ...input, attachments: summary }))
      const changed = structuredClone(attachment)
      if (attachment.kind === 'document') changed.document.sections[0].text = 'changed extraction'
      else Object.assign(changed, image(256, 'q'))
      assert.throws(() => db.beginTurn({ ...input, attachments: [changed] }), error => error.status === 409)
      if (attachment.kind === 'document') {
        const warning = structuredClone(attachment); warning.document.warnings.push('changed')
        assert.equal(chatAttachmentsMatch(summary, [warning]), false)
      }
      assert.equal(db.listMessages('main').filter(message => message.requestId === input.requestId).length, 1)
      db.retractRequest({ requestId: input.requestId, conversationId: 'main' })
      assert.equal(db.beginTurn(input).claimed, false)
    }
    const plain = request(undefined, 'plain')
    assert.equal(db.beginTurn(plain).attachments, undefined)
    finish(db, 'plain')
    assert.equal(db.beginTurn({ ...plain, attachments: [] }).claimed, false)
  })

  test(`${engine}: new/legacy backup roundtrip, mismatch rollback and device-local preference`, t => {
    const source = fixture(t, engine), target = fixture(t, engine)
    const input = request([document()])
    source.db.beginTurn(input); finish(source.db)
    source.db.setPreference('mobile-reminders-enabled', false)
    const original = source.db.exportData()
    assert.equal(original.tables.state.some(row => row.key === 'preferences:mobile-reminders-enabled'), false)
    for (const legacy of [false, true]) {
      const backup = structuredClone(original)
      if (legacy) {
        const turn = JSON.parse(backup.tables.turns[0].document); turn.attachments = input.attachments
        backup.tables.turns[0].document = JSON.stringify(turn)
      }
      // Some external archives may include local settings. Validate but ignore.
      backup.tables.state.push({ key: 'preferences:mobile-reminders-enabled', value: 'false' }); resign(backup)
      for (const preference of [true, false]) {
        target.db.setPreference('mobile-reminders-enabled', preference)
        assert.equal(target.db.importData(backup).restored, true)
        assert.equal(target.db.getPreference('mobile-reminders-enabled'), preference)
        assert.deepEqual(target.db.getTurn('request').attachments, summarizeChatAttachments(input.attachments))
        assert.deepEqual(target.db.getMessage('request:user').attachments, input.attachments)
        assert.equal(target.db.beginTurn(input).claimed, false)
        assert.equal(target.db.importData(target.db.exportData()).restored, true)
        assert.equal(target.db.getPreference('mobile-reminders-enabled'), preference)
      }
      const fresh = fixture(t, engine)
      fresh.db.importData(backup)
      assert.equal(fresh.db.getPreference('mobile-reminders-enabled'), null)
      const corrupted = structuredClone(backup), turn = JSON.parse(corrupted.tables.turns[0].document)
      if (legacy) turn.attachments[0].document.sections[0].text = 'different source'
      else turn.attachments[0].sha256 = '0'.repeat(64)
      corrupted.tables.turns[0].document = JSON.stringify(turn); resign(corrupted)
      target.db.setPreference('mobile-reminders-enabled', true)
      assert.throws(() => target.db.importData(corrupted), /附件与原话不一致/u)
      assert.equal(target.db.getPreference('mobile-reminders-enabled'), true)
      assert.deepEqual(target.db.getMessage('request:user').attachments, input.attachments)
    }
  })

  test(`${engine}: startup migrates legacy full turns, preserves conflicts, retries once`, t => {
    const f = fixture(t, engine), input = request([image()])
    f.db.beginTurn(input); finish(f.db, 'request', 'failed')
    replaceTurn(f.driver, 'request', turn => { turn.attachments = input.attachments })
    const conflict = request([document()], 'conflict')
    f.db.beginTurn(conflict); finish(f.db, 'conflict')
    replaceTurn(f.driver, 'conflict', turn => { turn.attachments = structuredClone(conflict.attachments); turn.attachments[0].document.sections[0].text = 'legacy conflict' })
    f.reopen()
    assert.deepEqual(f.db.getTurn('request').attachments, summarizeChatAttachments(input.attachments))
    assert.ok(f.db.getTurn('conflict').attachments[0].data)
    assert.equal(f.db.beginTurn(input).claimed, true)
    finish(f.db)
    f.reopen()
    assert.equal(f.db.beginTurn(input).claimed, false)
    assert.equal(f.db.listMessages('main').length, 2)
  })

  test(`${engine}: two synthetic 6 MiB images export within 32 MiB`, t => {
    const f = fixture(t, engine), attachment = image(6 * MiB)
    for (let i = 0; i < 2; i++) { f.db.beginTurn(request([attachment], `large${i}`)); finish(f.db, `large${i}`) }
    const backup = f.db.exportData(), bytes = backupByteLength(serializeBackup(backup))
    assert.ok(bytes < 18 * MiB)
    assert.ok(backup.tables.turns.every(row => row.document.length < 2000 && !row.document.includes('base64,')))
    const target = fixture(t, engine); target.db.importData(backup)
    assert.equal(target.db.getMessage('large1:user').attachments[0].data, attachment.data)
    t.diagnostic(`two-image backup: ${bytes} bytes (${(bytes / MiB).toFixed(3)} MiB)`)
  })
}

test('sql.js: four 6 MiB images fit 64 MiB, old duplicate pages reclaimed on reopen', t => {
  const f = fixture(t, 'sql.js'), attachment = image(6 * MiB)
  for (let i = 0; i < 4; i++) { f.db.beginTurn(request([attachment], `large${i}`)); finish(f.db, `large${i}`) }
  const compact = f.driver.exportSnapshot().byteLength
  assert.ok(compact < 64 * MiB)
  for (let i = 0; i < 4; i++) replaceTurn(f.driver, `large${i}`, turn => { turn.attachments = [attachment] })
  const duplicated = f.driver.exportSnapshot().byteLength
  assert.ok(duplicated > 64 * MiB)
  f.reopen()
  const migrated = f.driver.exportSnapshot().byteLength
  assert.ok(migrated < 40 * MiB)
  assert.ok(migrated < duplicated - 24 * MiB)
  assert.equal(f.db.getMessage('large3:user').attachments[0].data, attachment.data)
  t.diagnostic(`four-image sql.js snapshot: new=${compact}, legacy=${duplicated}, migrated=${migrated} bytes`)
})

test('attachments and local reminder state survive Node ⇄ sql.js backups', t => {
  const desktop = fixture(t, 'node:sqlite'), mobile = fixture(t, 'sql.js')
  desktop.db.beginTurn(request([document()])); finish(desktop.db)
  mobile.db.setPreference('mobile-reminders-enabled', true)
  mobile.db.importData(desktop.db.exportData())
  assert.equal(mobile.db.getPreference('mobile-reminders-enabled'), true)
  mobile.db.beginTurn(request([image()], 'image')); finish(mobile.db, 'image')
  desktop.db.setPreference('mobile-reminders-enabled', false)
  desktop.db.importData(mobile.db.exportData())
  assert.equal(desktop.db.getPreference('mobile-reminders-enabled'), false)
  assert.deepEqual(desktop.db.getMessage('image:user').attachments, [image()])
  assert.deepEqual(desktop.db.getTurn('request').attachments, summarizeChatAttachments([document()]))
})

test('legacy failed attachment backups keep original bytes but never resume old tool execution', t => {
  for (const engine of ['node:sqlite', 'sql.js']) {
    const source = fixture(t, engine), target = fixture(t, engine), input = request([document()])
    source.db.beginTurn(input); finish(source.db, 'request', 'failed')
    const backup = source.db.exportData(), turn = JSON.parse(backup.tables.turns[0].document)
    turn.attachments = input.attachments; backup.tables.turns[0].document = JSON.stringify(turn); resign(backup)
    target.db.importData(backup)
    assert.ok(target.db.getTurn('request').retractedAt)
    assert.equal(target.db.beginTurn(input).claimed, false)
    assert.deepEqual(target.db.getMessage('request:user').attachments, input.attachments)
    assert.equal(target.db.beginTurn({ ...input, requestId: 'fresh' }).claimed, true)
    finish(target.db, 'fresh')
  }
})
