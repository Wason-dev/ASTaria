/** Compare immutable JSON API snapshots without allocating serialized copies. */
export function sameSnapshot(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameSnapshot(value, right[index]))
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length
    && keys.every(key => Object.hasOwn(b, key) && sameSnapshot(a[key], b[key]))
}
