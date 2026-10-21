import { checkedSnapshot, MAX_MOBILE_DATABASE_BYTES } from './snapshots.mjs'

export const MAX_SNAPSHOT_BASE64_LENGTH = 4 * Math.ceil(MAX_MOBILE_DATABASE_BYTES / 3)
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64Ascii = new TextEncoder().encode(alphabet)
const asciiDecoder = new TextDecoder()
const invalid = () => new Error('本机数据校验失败，原数据已保留；请先恢复备份')

// Check the wire representation without decoding or hashing on the UI thread.
// A single character-class scan avoids recursive regex groups on large files.
export function validateSnapshotBase64(value) {
  if (typeof value !== 'string' || value.length < 136 || value.length > MAX_SNAPSHOT_BASE64_LENGTH
    || value.length % 4 !== 0) throw invalid()
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const end = value.length - padding
  const bytes = value.length / 4 * 3 - padding
  if (bytes < 100 || bytes > MAX_MOBILE_DATABASE_BYTES
    || /[^A-Za-z0-9+/]/u.test(value.slice(0, end))) throw invalid()
  // Reject nonzero unused bits: different strings must not name the same bytes.
  const last = alphabet.indexOf(value[end - 1])
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) throw invalid()
  return value
}

// Only the Worker calls these codecs. Neither function transfers or detaches
// the session's acknowledged bytes, which remain its rollback point.
export function encodeSnapshot(bytes) {
  checkedSnapshot(bytes)
  const output = new Uint8Array(4 * Math.ceil(bytes.length / 3))
  const end = bytes.length - bytes.length % 3
  let offset = 0, target = 0
  for (; offset < end; offset += 3) {
    const value = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
    output[target++] = base64Ascii[value >>> 18]
    output[target++] = base64Ascii[(value >>> 12) & 63]
    output[target++] = base64Ascii[(value >>> 6) & 63]
    output[target++] = base64Ascii[value & 63]
  }
  if (offset < bytes.length) {
    const first = bytes[offset], second = offset + 1 < bytes.length ? bytes[offset + 1] : 0
    output[target++] = base64Ascii[first >>> 2]
    output[target++] = base64Ascii[((first & 3) << 4) | (second >>> 4)]
    output[target++] = offset + 1 < bytes.length ? base64Ascii[(second & 15) << 2] : 61
    output[target] = 61 // '=' padding
  }
  return asciiDecoder.decode(output)
}

export function decodeSnapshot(value) {
  validateSnapshotBase64(value)
  const text = atob(value)
  const bytes = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index)
  return checkedSnapshot(bytes)
}
