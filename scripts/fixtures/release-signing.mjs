import { generateKeyPairSync, sign } from 'node:crypto'
import { manifestSigningBytes } from '../../desktop/releaseTrust.mjs'

// Ephemeral test key. Never use the publisher's key in a test process.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
export const testReleaseKeys = { 'test-only': publicKey }
export function signTestManifest(value) {
  const manifest = JSON.parse(JSON.stringify(value))
  return { ...manifest, signature: { algorithm: 'Ed25519', keyId: 'test-only',
    value: sign(null, manifestSigningBytes(manifest), privateKey).toString('base64') } }
}
