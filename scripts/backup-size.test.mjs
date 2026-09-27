import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { BACKUP_MAX_BYTES, BACKUP_IMPORT_REQUEST_MAX_BYTES, backupByteLength, serializeBackup } from '../src/xixi/backupLimits.ts'

function sizedBackup(bytes) {
  const db = createDatabase(':memory:')
  try {
    const conversation = db.getActiveConversation()
    for (let index = 0; index < 6; index++) db.appendMessage({
      id: `size-message-${index}`, conversationId: conversation.id,
      role: 'assistant', content: '', reasoningContent: '',
    })
    const backup = db.exportData()
    let remaining = bytes - Buffer.byteLength(serializeBackup(backup))
    for (const row of backup.tables.messages) {
      const document = JSON.parse(row.document)
      const count = Math.min(1_999_998, Math.floor(remaining / 3))
      document.reasoningContent = '界'.repeat(count)
      remaining -= count * 3
      if (remaining < 3) { document.reasoningContent += 'x'.repeat(remaining); remaining = 0 }
      row.document = JSON.stringify(document)
    }
    assert.equal(remaining, 0)
    backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex')
    assert.equal(Buffer.byteLength(serializeBackup(backup)), bytes)
    return backup
  } finally { db.close() }
}

function fixture(t) {
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw new Error('Unexpected model call') } })
  t.after(() => service.close())
  return { db, service }
}

function invoke(service, path, raw) {
  return new Promise(resolve => {
    const buffer = raw === undefined ? null : Buffer.from(raw)
    // Splitting at arbitrary byte offsets also exercises UTF-8 chunk joins.
    const chunks = buffer ? (function* () { for (let at = 0; at < buffer.length; at += 65537) yield buffer.subarray(at, at + 65537) })() : []
    const request = Readable.from(chunks)
    request.url = `/api${path}`; request.method = buffer ? 'POST' : 'GET'
    request.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    request.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    const response = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }
    service.middleware(request, response, () => resolve({ status: 404 }))
  })
}

test('UTF-8 pretty backups one byte below and exactly at the limit restore through middleware', async t => {
  const { db, service } = fixture(t)
  for (const bytes of [BACKUP_MAX_BYTES - 1, BACKUP_MAX_BYTES]) {
    const backup = sizedBackup(bytes), file = serializeBackup(backup)
    assert.ok(file.length < BACKUP_MAX_BYTES, 'Chinese data is counted in UTF-8 bytes, not JS string length')
    assert.equal(backupByteLength(file), bytes)
    assert.equal(new Blob([file]).size, bytes)
    const raw = JSON.stringify({ backup: JSON.parse(file), confirmed: true })
    assert.ok(Buffer.byteLength(raw) <= BACKUP_IMPORT_REQUEST_MAX_BYTES)
    const result = await invoke(service, '/data/import', raw)
    assert.equal(result.status, 200)
    assert.equal(result.value.restored, true)
    assert.equal(db.listMessages(db.getActiveConversation().id).length, 6)
  }
})

test('pretty JSON above the file limit is refused even when compact JSON fits, without changing data', async t => {
  const { db, service } = fixture(t)
  db.createTask({ title: '保留原事项' })
  const before = db.exportData(), backup = sizedBackup(BACKUP_MAX_BYTES + 1)
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) < BACKUP_MAX_BYTES)
  assert.throws(() => db.importData(backup), error => error.status === 413 && /32 MiB/.test(error.message))
  const result = await invoke(service, '/data/import', JSON.stringify({ backup, confirmed: true }))
  assert.equal(result.status, 413)
  assert.match(result.value.error, /本机数据未改动/)
  assert.deepEqual(db.exportData().tables, before.tables)
})

test('export refuses a newly grown database before returning an unrestorable file', async t => {
  const { db, service } = fixture(t)
  db.importData(sizedBackup(BACKUP_MAX_BYTES))
  const conversation = db.getActiveConversation()
  db.appendMessage({ conversationId: conversation.id, role: 'assistant', content: '新的一轮' })
  assert.throws(() => db.exportData(), error => error.status === 413 && /未生成可恢复的备份文件/.test(error.message))
  const result = await invoke(service, '/data/export')
  assert.equal(result.status, 413)
  assert.match(result.value.error, /未生成可恢复的备份文件/)
  assert.equal(result.value.tables, undefined)
  assert.equal(db.listMessages(conversation.id).length, 7)
})

test('HTTP body reserves the exact import envelope and still rejects oversized or malformed requests atomically', async t => {
  const { db, service } = fixture(t)
  const backup = db.exportData(), before = backup.tables
  const body = JSON.stringify({ backup, confirmed: true })
  const overhead = Buffer.byteLength(body) - Buffer.byteLength(JSON.stringify(backup))
  assert.equal(BACKUP_IMPORT_REQUEST_MAX_BYTES, BACKUP_MAX_BYTES + overhead)
  // Valid JSON may have whitespace. Fill the wire budget exactly, independently
  // of canonical backup formatting, to prove the wrapper allowance is applied.
  const atLimit = body + ' '.repeat(BACKUP_IMPORT_REQUEST_MAX_BYTES - Buffer.byteLength(body))
  assert.equal((await invoke(service, '/data/import', atLimit)).status, 200)
  const restored = db.exportData().tables
  assert.equal((await invoke(service, '/data/import', atLimit + ' ')).status, 413)
  assert.deepEqual(db.exportData().tables, restored)
  assert.equal((await invoke(service, '/data/import', '{broken')).status, 400)
  assert.deepEqual(db.exportData().tables, restored)
  assert.ok(before)
  assert.equal((await invoke(service, '/preferences', ' '.repeat(4 * 1024 * 1024 + 1))).status, 413)
})
