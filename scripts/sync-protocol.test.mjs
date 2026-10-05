import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import { decryptSyncOperation, encryptSyncOperation, mergeSyncDocument, validateSyncOperation } from '../server/syncProtocol.mjs'

const makeOperation = (overrides = {}) => ({
  schema: 1, operationId: 'a'.repeat(32), deviceId: 'b'.repeat(32), sequence: 1,
  entity: 'tasks', entityId: 'task-1', baseRevision: null, type: 'put',
  before: null, after: { id: 'task-1', title: '复习' }, createdAt: '2026-10-05T00:00:00.000Z',
  ...overrides,
})

test('operation file roundtrips with independent nonces and authenticated identity', () => {
  const key = randomBytes(32), operation = makeOperation()
  const first = encryptSyncOperation(operation, key)
  const second = encryptSyncOperation(operation, key)
  assert.notDeepEqual(first, second)
  assert.deepEqual(decryptSyncOperation(first, key), operation)
  assert.deepEqual(decryptSyncOperation(second, key), operation)
  const changedHeader = JSON.parse(first)
  changedHeader.sequence = 2
  assert.throws(() => decryptSyncOperation(Buffer.from(JSON.stringify(changedHeader)), key), /篡改/)
})

test('wrong key, altered nonce or ciphertext, malformed file and incompatible version fail closed', () => {
  const key = randomBytes(32), file = encryptSyncOperation(makeOperation(), key)
  assert.throws(() => decryptSyncOperation(file, randomBytes(32)), /密钥错误|篡改/)
  for (const field of ['nonce', 'ciphertext']) {
    const changed = JSON.parse(file)
    const bytes = Buffer.from(changed[field], 'base64')
    bytes[0] ^= 1
    changed[field] = bytes.toString('base64')
    assert.throws(() => decryptSyncOperation(Buffer.from(JSON.stringify(changed)), key))
  }
  assert.throws(() => decryptSyncOperation(Buffer.from('partial'), key), /大小/)
  const incompatible = JSON.parse(file)
  incompatible.schema = 2
  assert.throws(() => decryptSyncOperation(Buffer.from(JSON.stringify(incompatible)), key), /版本/)
  assert.throws(() => validateSyncOperation(makeOperation({ baseRevision: undefined })), /版本/)
})

test('field merge preserves unrelated local edits, exposes same-field conflict and protects tombstones', () => {
  const before = { title: '旧标题', note: '旧备注', due: '2026-10-10' }
  const after = { ...before, title: '新标题' }
  assert.deepEqual(mergeSyncDocument(before, after, { ...before, note: '本机备注' }),
    { value: { ...after, note: '本机备注' }, conflicts: [] })
  assert.deepEqual(mergeSyncDocument(before, after, { ...before, title: '另一标题' }),
    { value: { ...before, title: '另一标题' }, conflicts: ['title'] })
  assert.deepEqual(mergeSyncDocument(before, null, { ...before, note: '本机备注' }),
    { value: { ...before, note: '本机备注' }, conflicts: ['record'] })
  assert.deepEqual(mergeSyncDocument(null, after, null), { value: after, conflicts: [] })
})
