/** Parse SemVer, allowing v-prefixed release tags and stable display tags such as v1.0. */
export function versionParts(value) {
  if (typeof value !== 'string' || value.length > 120) return null
  const display = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value)
  const normalized = display?.[0] === value ? `${display[1]}.${display[2]}.0` : value
  if (normalized.length > 120) return null
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u.exec(normalized)
  if (!match || match[0] !== normalized) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some(part => /^\d+$/u.test(part) && part.length > 1 && part[0] === '0')) return null
  return { core: match.slice(1, 4).map(BigInt), pre, version: normalized.replace(/^v/u, '') }
}

/** Package and installer versions must already be canonical three-part SemVer. */
export function isCanonicalVersion(value) {
  const parts = versionParts(value)
  return parts !== null && parts.version === value
}

/** SemVer ordering, including numeric prereleases; build metadata has no precedence. */
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) throw new Error('Invalid version')
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    const x = a.pre[index], y = b.pre[index]
    if (x === y) continue
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}
