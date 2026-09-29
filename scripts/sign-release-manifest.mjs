import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestSigningBytes, RELEASE_KEYS, verifyReleaseManifest } from '../desktop/releaseTrust.mjs'

export async function signReleaseManifest(manifest, keyPath, keyId = 'wason-2026-01') {
  const info = await lstat(keyPath)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Release key must be a private regular file (mode 600)')
  const privateKey = createPrivateKey(await readFile(keyPath))
  if (privateKey.asymmetricKeyType !== 'ed25519' || !Object.hasOwn(RELEASE_KEYS, keyId)
    || createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).trim() !== RELEASE_KEYS[keyId].trim()) throw new Error('Release key does not match the public key shipped in ASTaria')
  const signed = { ...manifest, signature: { algorithm: 'Ed25519', keyId, value: sign(null, manifestSigningBytes(manifest), privateKey).toString('base64') } }
  verifyReleaseManifest(signed)
  return signed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [path, keyPath] = process.argv.slice(2)
  if (!path || !keyPath || process.argv.length !== 4) throw new Error('Usage: node scripts/sign-release-manifest.mjs <manifest.json> <private-key.pem>')
  const manifest = await signReleaseManifest(JSON.parse(await readFile(path, 'utf8')), keyPath)
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log('Release manifest signed and verified')
}
