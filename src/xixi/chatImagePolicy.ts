// Shared by the browser and local service. Header inspection never decodes pixels.
export const CHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'
export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const CHAT_IMAGE_MAX_EDGE = 8192
export const CHAT_IMAGE_MAX_PIXELS = 16_777_216
export const CHAT_IMAGE_MAX_BASE64_LENGTH = Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4

export type ChatImageMime = 'image/png' | 'image/jpeg' | 'image/webp'
export type ChatImageDimensions = { width: number; height: number }
export type ChatImageInfo = ChatImageDimensions & { mime: ChatImageMime }

function invalid(): never { throw new Error('图片内容已损坏或格式不正确，请重新选择') }
function unsupported(): never { throw new Error('仅支持 PNG、JPEG 或 WebP 图片') }
const tag = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
const uint16 = (bytes: Uint8Array, offset: number) => bytes[offset] * 256 + bytes[offset + 1]
const uint24le = (bytes: Uint8Array, offset: number) => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536
const uint32 = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset)
const uint32le = (bytes: Uint8Array, offset: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function checkPngCrc(bytes: Uint8Array, start: number, end: number): void {
  let crc = 0xffffffff
  for (let offset = start; offset < end; offset++) crc = (crc >>> 8) ^ pngCrcTable[(crc ^ bytes[offset]) & 255]
  if (((crc ^ 0xffffffff) >>> 0) !== uint32(bytes, end)) invalid()
}

export function assertChatImageSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('图片不能为空，请重新选择')
  if (size > CHAT_IMAGE_MAX_BYTES) throw new Error('图片大小不能超过 10 MiB')
}

export function assertChatImageDimensions({ width, height }: ChatImageDimensions): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid()
  if (width > CHAT_IMAGE_MAX_EDGE || height > CHAT_IMAGE_MAX_EDGE) throw new Error('图片最长边不能超过 8192 像素')
  if (width * height > CHAT_IMAGE_MAX_PIXELS) throw new Error('图片总像素不能超过 16,777,216')
}

function pngDimensions(bytes: Uint8Array): ChatImageDimensions {
  if (bytes.length < 33 || uint32(bytes, 8) !== 13 || tag(bytes, 12) !== 'IHDR') invalid()
  const dimensions = { width: uint32(bytes, 16), height: uint32(bytes, 20) }
  assertChatImageDimensions(dimensions)
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
  if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) invalid()
  checkPngCrc(bytes, 12, 29)
  let imageData = false
  for (let offset = 33; offset < bytes.length;) {
    if (offset + 12 > bytes.length) invalid()
    const length = uint32(bytes, offset), type = tag(bytes, offset + 4)
    const end = offset + 12 + length
    if (end > bytes.length || type === 'IHDR') invalid()
    checkPngCrc(bytes, offset + 4, end - 4)
    if (type === 'IDAT' && length > 0) imageData = true
    if (type === 'fcTL') {
      if (length !== 26) invalid()
      const frame = { width: uint32(bytes, offset + 12), height: uint32(bytes, offset + 16) }
      assertChatImageDimensions(frame)
      if (frame.width + uint32(bytes, offset + 20) > dimensions.width || frame.height + uint32(bytes, offset + 24) > dimensions.height) invalid()
    }
    if (type === 'IEND') {
      if (length !== 0 || !imageData || end !== bytes.length) invalid()
      return dimensions
    }
    offset = end
  }
  return invalid()
}

function jpegDimensions(bytes: Uint8Array): ChatImageDimensions {
  let offset = 2, inScan = false, sawScan = false
  let dimensions: ChatImageDimensions | undefined
  while (offset < bytes.length) {
    if (inScan) while (offset < bytes.length && bytes[offset] !== 0xff) offset++
    if (bytes[offset++] !== 0xff) invalid()
    while (bytes[offset] === 0xff) offset++
    if (offset >= bytes.length) invalid()
    const marker = bytes[offset++]
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (!inScan) invalid()
      continue
    }
    if (marker === 0x01) continue
    if (marker === 0xd9) {
      if (!dimensions || !sawScan || offset !== bytes.length) invalid()
      return dimensions
    }
    if (marker === 0xd8 || offset + 2 > bytes.length) invalid()
    const length = uint16(bytes, offset), end = offset + length
    if (length < 2 || end > bytes.length) invalid()
    inScan = false
    const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (sof) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) unsupported()
      if (dimensions || length < 8) invalid()
      const precision = bytes[offset + 2], components = bytes[offset + 7]
      if ((precision !== 8 && (marker === 0xc0 || precision !== 12)) || components < 1 || components > 4 || length !== 8 + 3 * components) invalid()
      dimensions = { width: uint16(bytes, offset + 5), height: uint16(bytes, offset + 3) }
      assertChatImageDimensions(dimensions)
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6 || bytes[offset + 2] < 1 || bytes[offset + 2] > 4 || length !== 6 + 2 * bytes[offset + 2]) invalid()
      sawScan = inScan = true
    }
    // APP/COM/table segments are skipped by their length, never searched for SOF bytes.
    offset = end
  }
  return invalid()
}

function webpBitstreamDimensions(bytes: Uint8Array, type: string, start: number, length: number): ChatImageDimensions {
  let dimensions: ChatImageDimensions
  if (type === 'VP8 ') {
    if (length < 10 || (bytes[start] & 1) !== 0 || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 0x01 || bytes[start + 5] !== 0x2a) invalid()
    dimensions = { width: (bytes[start + 6] + bytes[start + 7] * 256) & 0x3fff, height: (bytes[start + 8] + bytes[start + 9] * 256) & 0x3fff }
  } else {
    if (length < 5 || bytes[start] !== 0x2f) invalid()
    const bits = uint32le(bytes, start + 1)
    if ((bits >>> 29) !== 0) invalid()
    dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  assertChatImageDimensions(dimensions)
  return dimensions
}

function webpFrame(bytes: Uint8Array, start: number, end: number, expected?: ChatImageDimensions): ChatImageDimensions {
  let dimensions: ChatImageDimensions | undefined
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) invalid()
    const type = tag(bytes, offset), length = uint32le(bytes, offset + 4)
    const next = offset + 8 + length + (length % 2)
    if (next > end || !['ALPH', 'VP8 ', 'VP8L'].includes(type)) invalid()
    if (type !== 'ALPH') {
      if (dimensions) invalid()
      dimensions = webpBitstreamDimensions(bytes, type, offset + 8, length)
    }
    offset = next
  }
  if (!dimensions || (expected && (dimensions.width !== expected.width || dimensions.height !== expected.height))) invalid()
  return dimensions
}

function webpDimensions(bytes: Uint8Array): ChatImageDimensions {
  if (bytes.length < 20 || uint32le(bytes, 4) + 8 !== bytes.length) invalid()
  let canvas: ChatImageDimensions | undefined, image: ChatImageDimensions | undefined
  let animated = false, animationHeader = false, frames = 0
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) invalid()
    const type = tag(bytes, offset), length = uint32le(bytes, offset + 4), start = offset + 8
    const end = start + length, next = end + (length % 2)
    if (next > bytes.length) invalid()
    if (offset === 12 && !['VP8X', 'VP8 ', 'VP8L'].includes(type)) invalid()
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10 || (bytes[start] & 0xc1) || bytes[start + 1] || bytes[start + 2] || bytes[start + 3]) invalid()
      canvas = { width: uint24le(bytes, start + 4) + 1, height: uint24le(bytes, start + 7) + 1 }
      assertChatImageDimensions(canvas)
      animated = Boolean(bytes[start] & 2)
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (animated || image) invalid()
      image = webpBitstreamDimensions(bytes, type, start, length)
      if (canvas && (canvas.width !== image.width || canvas.height !== image.height)) invalid()
    } else if (type === 'ANIM') {
      if (!animated || animationHeader || frames || length !== 6) invalid()
      animationHeader = true
    } else if (type === 'ANMF') {
      if (!animated || !animationHeader || !canvas || length < 16 || (bytes[start + 15] & 0xfc)) invalid()
      const frame = { width: uint24le(bytes, start + 6) + 1, height: uint24le(bytes, start + 9) + 1 }
      assertChatImageDimensions(frame)
      if (uint24le(bytes, start) * 2 + frame.width > canvas.width || uint24le(bytes, start + 3) * 2 + frame.height > canvas.height) invalid()
      webpFrame(bytes, start + 16, end, frame)
      frames++
    }
    offset = next
  }
  if (animated) {
    if (!frames || !canvas) invalid()
    return canvas
  }
  if (!image) invalid()
  return canvas ?? image
}

export function inspectChatImage(bytes: Uint8Array): ChatImageInfo {
  assertChatImageSize(bytes.byteLength)
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    return { mime: 'image/png', ...pngDimensions(bytes) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mime: 'image/jpeg', ...jpegDimensions(bytes) }
  if (tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WEBP') return { mime: 'image/webp', ...webpDimensions(bytes) }
  return unsupported()
}
