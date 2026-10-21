import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { sha256Hex } from './portable.mjs'
import { SYNC_SCHEMA, MAX_OPERATION_BYTES, syncRevision, validateSyncOperation } from './syncModel.mjs'

// Pure schema, revision and merge rules live in syncModel so a mobile build can
// share them without Node crypto. This module keeps the file envelope.
export { SYNC_SCHEMA, MAX_OPERATION_BYTES, syncRevision, validateSyncOperation, mergeSyncDocument } from './syncModel.mjs'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = value => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)
const digest = value => sha256Hex(value)

export function encryptSyncOperation(operation, key) {
  validateSyncOperation(operation)
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('同步密钥长度无效')
  const plain = Buffer.from(JSON.stringify(operation), 'utf8')
  if (plain.length > MAX_OPERATION_BYTES) throw new Error('同步操作过大')
  const header = { schema: SYNC_SCHEMA, algorithm: 'AES-256-GCM', deviceId: operation.deviceId,
    sequence: operation.sequence, operationId: operation.operationId }
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(JSON.stringify(header)))
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.from(`${JSON.stringify({ ...header, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'), sha256: digest(encrypted) })}\n`)
}

export function decryptSyncOperation(file, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('同步密钥长度无效')
  if (!Buffer.isBuffer(file) || file.length > MAX_OPERATION_BYTES * 2 || file.length < 100) throw new Error('同步文件大小无效')
  let envelope
  try { envelope = JSON.parse(file.toString('utf8')) } catch { throw new Error('同步文件无法解析') }
  if (!isObject(envelope) || envelope.schema !== SYNC_SCHEMA || envelope.algorithm !== 'AES-256-GCM'
    || !hex(envelope.deviceId) || !hex(envelope.operationId)
    || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new Error('同步文件格式或版本不兼容')
  const decode = (value, size) => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) throw new Error('同步文件编码无效')
    const bytes = Buffer.from(value, 'base64')
    if (size && bytes.length !== size || bytes.toString('base64') !== value) throw new Error('同步文件编码无效')
    return bytes
  }
  const nonce = decode(envelope.nonce, 12), tag = decode(envelope.tag, 16), ciphertext = decode(envelope.ciphertext)
  if (digest(ciphertext) !== envelope.sha256) throw new Error('同步文件校验失败')
  const { schema, algorithm, deviceId, sequence, operationId } = envelope
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(JSON.stringify({ schema, algorithm, deviceId, sequence, operationId })))
  decipher.setAuthTag(tag)
  let operation
  try { operation = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) }
  catch { throw new Error('同步密钥错误或文件已被篡改') }
  validateSyncOperation(operation)
  if (operation.deviceId !== deviceId || operation.sequence !== sequence || operation.operationId !== operationId) throw new Error('同步文件身份不一致')
  return operation
}
