import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

// These small primitives have the same JSON/binary contract in Node and a
// mobile WebView. They do not provide filesystem, network or process access.
export const sha256Hex = value => bytesToHex(sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value))
export const randomUUID = () => globalThis.crypto.randomUUID()
export function randomHex(bytes = 16) {
  return bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))
}
export function jsonEqual(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = Object.keys(left), b = Object.keys(right)
  return a.length === b.length && a.every(key => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
}
export function decodeBase64(value) {
  const text = atob(value)
  return Uint8Array.from(text, character => character.charCodeAt(0))
}
export function encodeBase64(bytes) {
  let text = ''
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(text)
}
export function joinBytes(chunks) {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
