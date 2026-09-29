import { verify } from 'node:crypto'

// Only the public key ships in ASTaria. Release assets and the writable update
// cache can provide a signature, never a new trust anchor.
export const RELEASE_KEYS = Object.freeze({
  'wason-2026-01': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWK8DZMaTcEgN9AAKpXaz0/4zGk1Tcw06jKRnYUJpyP8=
-----END PUBLIC KEY-----`,
})

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  throw new Error('Invalid manifest value')
}

export function manifestSigningBytes(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid manifest')
  const { signature: _signature, ...payload } = manifest
  // Domain separation keeps release signatures distinct from other signed data.
  return Buffer.from(`ASTaria release manifest v1\n${canonical(payload)}`, 'utf8')
}

export function verifyReleaseManifest(manifest, trustedKeys = RELEASE_KEYS) {
  try {
    const signature = manifest?.signature
    if (signature?.algorithm !== 'Ed25519' || !Object.hasOwn(trustedKeys, signature.keyId)
      || typeof signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.value)) throw new Error('Invalid signature')
    if (!verify(null, manifestSigningBytes(manifest), trustedKeys[signature.keyId], Buffer.from(signature.value, 'base64'))) throw new Error('Invalid signature')
    return manifest
  } catch {
    throw new Error('无法验证此更新的发布者签名，请到 ASTaria 官方发布页核对')
  }
}
