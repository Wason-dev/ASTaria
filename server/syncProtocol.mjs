import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const SYNC_SCHEMA = 1
export const MAX_OPERATION_BYTES = 16_000_000
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = value => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
export function syncRevision(value) {
  const ordered = v => Array.isArray(v) ? v.map(ordered) : isObject(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v
  return digest(JSON.stringify(ordered(value)))
}

export function validateSyncOperation(value) {
  if (!isObject(value) || value.schema !== SYNC_SCHEMA || !hex(value.operationId) || !hex(value.deviceId)
    || Object.keys(value).some(k => !['schema', 'operationId', 'deviceId', 'sequence', 'entity', 'entityId', 'baseRevision', 'type', 'createdAt', 'before', 'after', 'groupId'].includes(k))
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !['tasks', 'areas', 'events', 'availability', 'assignments', 'planner', 'transaction'].includes(value.entity)
    || typeof value.entityId !== 'string' || !value.entityId || value.entityId.length > 200
    || !['put', 'delete'].includes(value.type) || typeof value.createdAt !== 'string'
    || !(value.baseRevision === null || typeof value.baseRevision === 'string' && value.baseRevision.length > 0 && value.baseRevision.length <= 200)
    || !Number.isFinite(Date.parse(value.createdAt)) || (value.before !== null && !isObject(value.before))
    || (value.after !== null && !isObject(value.after)) || (value.type === 'put' && !value.after)
    || (value.type === 'delete' && value.after !== null)) throw new Error('同步操作格式或版本不兼容')
  if (value.entity === 'transaction') {
    if (!hex(value.groupId) || value.before !== null || value.type !== 'put'
      || !Array.isArray(value.after.changes) || !value.after.changes.length || value.after.changes.length > 20000) throw new Error('同步事务格式无效')
    const seen = new Set()
    for (const change of value.after.changes) {
      if (!isObject(change) || !['tasks', 'areas', 'events', 'availability', 'assignments', 'planner', 'goals', 'completions'].includes(change.entity)
        || typeof change.entityId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/u.test(change.entityId)
        || (change.before !== null && !isObject(change.before)) || (change.after !== null && !isObject(change.after))
        || change.baseRevision !== syncRevision(change.before)
        || Object.keys(change).some(k => !['entity', 'entityId', 'before', 'after', 'baseRevision'].includes(k))) throw new Error('同步变更格式无效')
      const identity = `${change.entity}/${change.entityId}`
      if (seen.has(identity)) throw new Error('同步事务包含重复实体')
      seen.add(identity)
    }
  }
  return value
}

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

export function mergeSyncDocument(before, after, current) {
  if (isDeepStrictEqual(current, after)) return { value: current, conflicts: [] }
  if (isDeepStrictEqual(current, before)) return { value: after, conflicts: [] }
  if (!isObject(before) || !isObject(after) || !isObject(current)) return { value: current, conflicts: ['record'] }
  const changes = Object.keys({ ...before, ...after }).filter(key => !isDeepStrictEqual(before[key], after[key]))
  const conflicts = changes.filter(key => !isDeepStrictEqual(current[key], before[key])
    && !isDeepStrictEqual(current[key], after[key]))
  if (conflicts.length) return { value: current, conflicts }
  const value = { ...current }
  for (const key of changes) {
    if (Object.hasOwn(after, key)) Object.defineProperty(value, key, { value: after[key], writable: true, enumerable: true, configurable: true })
    else delete value[key]
  }
  return { value, conflicts: [] }
}
