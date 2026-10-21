import { sha256Hex, jsonEqual } from './portable.mjs'

export const SYNC_SCHEMA = 1
export const MAX_OPERATION_BYTES = 16_000_000
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hex = value => typeof value === 'string' && /^[0-9a-f]{32}$/u.test(value)
const digest = value => sha256Hex(value)
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

export function mergeSyncDocument(before, after, current) {
  if (jsonEqual(current, after)) return { value: current, conflicts: [] }
  if (jsonEqual(current, before)) return { value: after, conflicts: [] }
  if (!isObject(before) || !isObject(after) || !isObject(current)) return { value: current, conflicts: ['record'] }
  const changes = Object.keys({ ...before, ...after }).filter(key => !jsonEqual(before[key], after[key]))
  const conflicts = changes.filter(key => !jsonEqual(current[key], before[key])
    && !jsonEqual(current[key], after[key]))
  if (conflicts.length) return { value: current, conflicts }
  const value = { ...current }
  for (const key of changes) {
    if (Object.hasOwn(after, key)) Object.defineProperty(value, key, { value: after[key], writable: true, enumerable: true, configurable: true })
    else delete value[key]
  }
  return { value, conflicts: [] }
}
