import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { readChatAttachment, readChatImage, CHAT_IMAGE_ACCEPT, CHAT_IMAGE_MAX_BYTES, chatImageSize } from '../src/xixi/chatAttachments.ts'
import { CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_MAX_PIXELS, CHAT_IMAGE_MAX_BASE64_LENGTH, inspectChatImage } from '../src/xixi/chatImagePolicy.ts'
import { MAX_CHAT_IMAGE_BYTES, CHAT_IMAGE_TYPES, normalizeChatAttachments } from '../server/chatAttachments.mjs'

// Real 2 × 3 images generated and decoded offline, including all supported headers.
const fixtures = {
  "png": "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOMatrCwMDAxAAGUAoAHaoBllxQ+i0AAAAASUVORK5CYII=",
  "jpeg": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCOiiivcPKP/9k=",
  "jpegProgressive": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUAQEAAAAAAAAAAAAAAAAAAAAE/9oADAMBAAIQAxAAAAGQ4n//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAn//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/An//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==",
  "webp": "UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAMAAUAmJZgCdLoAA5gA/su3/8Q50OdDl/7+tr23hhQAAAA=",
  "webpLossless": "UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQwWqVtv+BiOh/AAA=",
  "webpExtended": "UklGRmAAAABXRUJQVlA4WAoAAAAgAAAAAQAAAgAASUNDUA8AAABmaXh0dXJlIHByb2ZpbGUAVlA4ICoAAACQAQCdASoCAAMAAUAmJZgCdLoAA5gA/su3/8Q50OdDl/7+tr23hhQAAAA=",
  "jpegExtended": "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wQARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCOiiivcPKP/9k="
}
const mimeFor = name => name.startsWith('jpeg') ? 'image/jpeg' : name.startsWith('webp') ? 'image/webp' : 'image/png'
const png = Buffer.from(fixtures.png, 'base64')
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}
function pngDimensions(width, height) {
  const bytes = Buffer.from(png)
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29)
  return bytes
}
function paddedPng(size) {
  const text = Buffer.alloc(size - png.length - 12, 'p')
  Buffer.from('Padding\0').copy(text)
  return Buffer.concat([png.subarray(0, -12), pngChunk('tEXt', text), png.subarray(-12)])
}
function realPng(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8
  const rows = Buffer.alloc((width + 1) * height)
  return Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
}
function riffChunk(type, data) {
  const chunk = Buffer.alloc(8 + data.length + data.length % 2)
  chunk.write(type); chunk.writeUInt32LE(data.length, 4); data.copy(chunk, 8)
  return chunk
}
function animatedWebp() {
  const canvas = Buffer.alloc(10); canvas[0] = 2; canvas.writeUIntLE(1, 4, 3); canvas.writeUIntLE(2, 7, 3)
  const frame = Buffer.alloc(16); frame.writeUIntLE(1, 6, 3); frame.writeUIntLE(2, 9, 3); frame.writeUIntLE(100, 12, 3)
  const chunks = Buffer.concat([riffChunk('VP8X', canvas), riffChunk('ANIM', Buffer.alloc(6)), riffChunk('ANMF', Buffer.concat([frame, Buffer.from(fixtures.webpLossless, 'base64').subarray(12)]))])
  const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(chunks.length + 4, 4); header.write('WEBP', 8)
  return Buffer.concat([header, chunks])
}
const decodeHeader = async blob => inspectChatImage(new Uint8Array(await blob.arrayBuffer()))
const fileFor = (bytes, type = 'image/png', name = '原图.png') => new File([bytes], name, { type })
const serverImage = (bytes, mime = 'image/png') => ({ name: '原图.png', mime, size: bytes.length, data: `data:${mime};base64,${bytes.toString('base64')}` })

test('browser FileReader encodes inspected original bytes asynchronously and propagates read errors', async t => {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'FileReader')
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'FileReader',previous);else delete globalThis.FileReader})
  let calls=0,fail=false
  globalThis.FileReader=class {
    async readAsDataURL(blob){calls++;if(fail){this.onerror();return}this.result=`data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;this.onload()}
  }
  const image=await readChatImage(fileFor(png),{decodeImage:decodeHeader})
  assert.equal(image.data,serverImage(png).data);assert.equal(calls,1)
  fail=true;await assert.rejects(readChatImage(fileFor(png),{decodeImage:decodeHeader}),/图片读取失败/)
})

test('client and server share the exact byte, MIME, edge and pixel limits', () => {
  assert.equal(CHAT_IMAGE_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(MAX_CHAT_IMAGE_BYTES, CHAT_IMAGE_MAX_BYTES)
  assert.equal(CHAT_IMAGE_MAX_EDGE, 8192)
  assert.equal(CHAT_IMAGE_MAX_PIXELS, 16_777_216)
  assert.equal(CHAT_IMAGE_MAX_BASE64_LENGTH, Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4)
  assert.deepEqual([...CHAT_IMAGE_TYPES], CHAT_IMAGE_ACCEPT.split(','))
  assert.equal(chatImageSize(CHAT_IMAGE_MAX_BYTES), '10.0 MiB')
})

for (const [name, encoded] of Object.entries(fixtures)) {
  test(`real ${name} is recognized by bytes and preserved despite a wrong extension and MIME`, async () => {
    const bytes = Buffer.from(encoded, 'base64'), mime = mimeFor(name)
    assert.deepEqual(inspectChatImage(bytes), { mime, width: 2, height: 3 })
    let calls = 0
    const attachment = await readChatImage(fileFor(bytes, 'image/gif', '错误扩展名.gif'), { decodeImage: async blob => {
      calls++
      assert.equal(blob.type, mime)
      assert.equal(Buffer.compare(Buffer.from(await blob.arrayBuffer()), bytes), 0)
      return { width: 2, height: 3 }
    } })
    assert.equal(calls, 1)
    assert.equal(attachment.mime, mime)
    assert.equal(attachment.size, bytes.length)
    assert.equal(attachment.data, `data:${mime};base64,${encoded}`)
    assert.deepEqual(normalizeChatAttachments([attachment]), [attachment])
    const untyped = await readChatImage(fileFor(bytes, '', 'image'), { decodeImage: decodeHeader })
    assert.equal(untyped.mime, mime)
  })
}

for (const size of [2 * 1024 * 1024 + 1, CHAT_IMAGE_MAX_BYTES - 1, CHAT_IMAGE_MAX_BYTES]) {
  test(`${size} original bytes are accepted without compression or resizing on either side`, async () => {
    const bytes = paddedPng(size)
    let calls = 0
    const attachment = await readChatImage(fileFor(bytes), { decodeImage: async blob => {
      calls++
      assert.equal(blob.size, size)
      return decodeHeader(blob)
    } })
    assert.equal(calls, 1)
    assert.equal(attachment.size, size)
    assert.equal(Buffer.compare(Buffer.from(attachment.data.split(',')[1], 'base64'), bytes), 0)
    assert.equal(normalizeChatAttachments([attachment])[0].data, attachment.data)
  })
}

for (const [width, height] of [[8192, 2048], [4096, 4096]]) {
  test(`a real ${width} × ${height} PNG reaches the dimension boundary unchanged`, async () => {
    const bytes = realPng(width, height)
    const attachment = await readChatImage(fileFor(bytes), { decodeImage: decodeHeader })
    assert.equal(Buffer.compare(Buffer.from(attachment.data.split(',')[1], 'base64'), bytes), 0)
    assert.equal(normalizeChatAttachments([attachment])[0].size, bytes.length)
  })
}

test('empty and oversized files are rejected before reading or decoding', async () => {
  let reads = 0, decodes = 0
  for (const size of [0, CHAT_IMAGE_MAX_BYTES + 1]) {
    const file = { size, name: 'x.png', type: 'image/png', arrayBuffer: () => { reads++; throw new Error('must not read') } }
    await assert.rejects(readChatImage(file, { decodeImage: async () => { decodes++; return { width: 2, height: 3 } } }), size ? /10 MiB/u : /不能为空/u)
  }
  assert.equal(reads, 0); assert.equal(decodes, 0)
})

test('read errors and inconsistent file sizes never produce an attachment', async () => {
  const options = { decodeImage: async () => assert.fail('must not decode') }
  await assert.rejects(readChatImage({ size: png.length, arrayBuffer: async () => { throw new Error('read failed') } }, options), /读取失败/u)
  await assert.rejects(readChatImage({ size: png.length + 1, arrayBuffer: async () => Uint8Array.from(png).buffer }, options), /大小不一致/u)
})

test('forged declarations, truncated headers and invalid dimensions fail before decoding', async () => {
  const cases = [
    [Buffer.from('small test image'), /仅支持/u],
    [png.subarray(0, 24), /损坏/u],
    [pngDimensions(0, 3), /损坏/u],
    [pngDimensions(8193, 1), /8192/u],
    [pngDimensions(1, 8193), /8192/u],
    [pngDimensions(4097, 4096), /16,777,216/u],
    [pngDimensions(8192, 2049), /16,777,216/u],
    [pngDimensions(0xffffffff, 1), /8192/u],
  ]
  let calls = 0
  for (const [bytes, message] of cases) {
    await assert.rejects(readChatImage(fileFor(bytes), { decodeImage: async () => { calls++; return { width: 2, height: 3 } } }), message)
    assert.throws(() => normalizeChatAttachments([serverImage(bytes)]), message)
  }
  assert.equal(calls, 0)
})

test('PNG duplicate IHDR, invalid header CRC, chunk overflow and oversized APNG frames are rejected', () => {
  const crc = Buffer.from(png); crc[29] ^= 1
  const length = Buffer.from(png); length.writeUInt32BE(0xffffffff, 33)
  const frame = Buffer.alloc(26); frame.writeUInt32BE(8193, 4); frame.writeUInt32BE(1, 8)
  const animated = Buffer.concat([png.subarray(0, 33), pngChunk('fcTL', frame), png.subarray(33)])
  const duplicate = Buffer.concat([png.subarray(0, 33), png.subarray(8, 33), png.subarray(33)])
  for (const bytes of [crc, length, duplicate]) assert.throws(() => inspectChatImage(bytes), /损坏/u)
  assert.throws(() => inspectChatImage(animated), /8192/u)
})

test('JPEG segment bounds, duplicate SOF and unsupported SOF cannot hide dimensions', () => {
  const jpeg = Buffer.from(fixtures.jpeg, 'base64')
  for (const length of [0, 1, 0xffff]) {
    const bytes = Buffer.from(jpeg); bytes.writeUInt16BE(length, 4)
    assert.throws(() => inspectChatImage(bytes), /损坏/u)
  }
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0])), sos = jpeg.indexOf(Buffer.from([0xff, 0xda]))
  const segment = jpeg.subarray(sof, sof + 2 + jpeg.readUInt16BE(sof + 2))
  const duplicate = Buffer.concat([jpeg.subarray(0, sos), segment, jpeg.subarray(sos)])
  assert.throws(() => inspectChatImage(duplicate), /损坏/u)
  const oversized = Buffer.from(jpeg); oversized.writeUInt16BE(8193, sof + 7)
  assert.throws(() => inspectChatImage(oversized), /8192/u)
  const unsupported = Buffer.from(jpeg); unsupported[sof + 1] = 0xc3
  assert.throws(() => inspectChatImage(unsupported), /仅支持/u)
  // A SOF-like sequence inside APP metadata must be skipped, not used as dimensions.
  const app = Buffer.concat([Buffer.from([0xff, 0xe1, 0, segment.length + 2]), segment])
  assert.deepEqual(inspectChatImage(Buffer.concat([jpeg.subarray(0, 2), app, jpeg.subarray(2)])), { mime: 'image/jpeg', width: 2, height: 3 })
  assert.throws(() => inspectChatImage(jpeg.subarray(0, -2)), /损坏/u)
})

test('WebP sizes, reserved bits, canvas conflicts and animation frames are checked', () => {
  for (const name of ['webp', 'webpLossless', 'webpExtended']) {
    const bytes = Buffer.from(fixtures[name], 'base64'); bytes.writeUInt32LE(0xffffffff, 16)
    assert.throws(() => inspectChatImage(bytes), /损坏/u)
  }
  const riff = Buffer.from(fixtures.webp, 'base64'); riff.writeUInt32LE(0xffffffff, 4)
  assert.throws(() => inspectChatImage(riff), /损坏/u)
  const vp8 = Buffer.from(fixtures.webp, 'base64'); vp8.writeUInt16LE(8193, 26)
  assert.throws(() => inspectChatImage(vp8), /8192/u)
  const vp8l = Buffer.from(fixtures.webpLossless, 'base64'); vp8l.writeUInt32LE(8192, 21)
  assert.throws(() => inspectChatImage(vp8l), /8192/u)
  const version = Buffer.from(fixtures.webpLossless, 'base64'); version[24] |= 0x80
  assert.throws(() => inspectChatImage(version), /损坏/u)
  const extended = Buffer.from(fixtures.webpExtended, 'base64'); extended.writeUIntLE(8192, 24, 3)
  assert.throws(() => inspectChatImage(extended), /8192/u)
  const conflict = Buffer.from(fixtures.webpExtended, 'base64'); conflict.writeUIntLE(0, 24, 3)
  assert.throws(() => inspectChatImage(conflict), /损坏/u)
  const reserved = Buffer.from(fixtures.webpExtended, 'base64'); reserved[21] = 1
  assert.throws(() => inspectChatImage(reserved), /损坏/u)
  const animation = animatedWebp()
  assert.deepEqual(inspectChatImage(animation), { mime: 'image/webp', width: 2, height: 3 })
  const frame = animation.indexOf('ANMF') + 8
  animation.writeUIntLE(8192, frame + 6, 3)
  assert.throws(() => inspectChatImage(animation), /8192/u)
})

test('a corrupt pixel payload reaches the decoder but is never accepted', async () => {
  const corrupt = Buffer.from(png); corrupt[45] ^= 0xff
  const idatLength = corrupt.readUInt32BE(33)
  corrupt.writeUInt32BE(crc32(corrupt.subarray(37, 41 + idatLength)), 41 + idatLength)
  assert.deepEqual(inspectChatImage(corrupt), { mime: 'image/png', width: 2, height: 3 })
  let calls = 0
  await assert.rejects(readChatImage(fileFor(corrupt), { decodeImage: async () => { calls++; throw new Error('invalid compressed pixels') } }), /损坏或无法解码/u)
  assert.equal(calls, 1)
})

test('decoded dimensions are validated, including EXIF rotation and header mismatches', async () => {
  const rotated = await readChatImage(fileFor(png), { decodeImage: async () => ({ width: 3, height: 2 }) })
  assert.equal(rotated.size, png.length)
  for (const dimensions of [{ width: 0, height: 3 }, { width: NaN, height: 3 }, { width: 8193, height: 1 }, { width: 4097, height: 4096 }, { width: 4, height: 3 }]) {
    await assert.rejects(readChatImage(fileFor(png), { decodeImage: async () => dimensions }), /损坏|8192|16,777,216|尺寸.*不一致/u)
  }
})

test('native bitmap decoding releases the bitmap even when decoded dimensions fail', async t => {
  let closed = 0, calls = 0, dimensions = { width: 2, height: 3 }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, writable: true, value: async blob => {
    calls++; assert.equal(blob.type, 'image/png')
    return { ...dimensions, close: () => closed++ }
  } })
  t.after(() => original ? Object.defineProperty(globalThis, 'createImageBitmap', original) : delete globalThis.createImageBitmap)
  await readChatImage(fileFor(png, 'image/jpeg'))
  dimensions = { width: 0, height: 0 }
  await assert.rejects(readChatImage(fileFor(png)), /损坏/u)
  assert.equal(calls, 2); assert.equal(closed, 2)
  globalThis.createImageBitmap = async () => { throw new Error('decode failed') }
  await assert.rejects(readChatImage(fileFor(png)), /损坏或无法解码/u)
  assert.equal(closed, 2)
})

test('Image fallback revokes object URLs on success, load failure and decode failure', async t => {
  const descriptors = ['Image', 'createImageBitmap'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  let failure = '', created = 0, revoked = 0, decoded = 0
  const images = []
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: undefined })
  Object.defineProperty(globalThis, 'Image', { configurable: true, value: class {
    naturalWidth = 2; naturalHeight = 3; onload = null; onerror = null; source = ''
    constructor() { images.push(this) }
    set src(value) { this.source = value; if (value) queueMicrotask(() => failure === 'load' ? this.onerror?.() : this.onload?.()) }
    async decode() { decoded++; if (failure === 'decode') throw new Error('corrupt pixels') }
  } })
  t.mock.method(URL, 'createObjectURL', blob => { assert.equal(blob.type, 'image/png'); created++; return `blob:test-${created}` })
  t.mock.method(URL, 'revokeObjectURL', () => revoked++)
  t.after(() => { for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } })
  await readChatImage(fileFor(png))
  failure = 'load'
  await assert.rejects(readChatImage(fileFor(png)), /损坏或无法解码/u)
  failure = 'decode'
  await assert.rejects(readChatImage(fileFor(png)), /损坏或无法解码/u)
  assert.equal(created, 3); assert.equal(revoked, 3); assert.equal(decoded, 2)
  for (const image of images) {
    assert.equal(image.source, ''); assert.equal(image.onload, null); assert.equal(image.onerror, null)
  }
})



test('PDF library control packets cannot terminate attachment reading; cancel owns the parser worker', async t => {
  const previous = globalThis.Worker
  let instance
  class ParserWorker {
    constructor() { instance = this; this.terminated = false }
    postMessage() {}
    terminate() { this.terminated = true }
  }
  globalThis.Worker = ParserWorker
  t.after(() => { if (previous) globalThis.Worker = previous; else delete globalThis.Worker })
  const file = new File(['%PDF-1.7\n%%EOF'], 'sample.pdf', { type: 'application/pdf' })
  const controller = new AbortController(), stages = []
  const pending = readChatAttachment(file, { signal: controller.signal, onProgress: title => stages.push(title) })
  instance.onmessage({ data: { sourceName: 'worker', targetName: 'main', action: 'ready' } })
  instance.onmessage({ data: { type: 'done', attachment: {} } })
  assert.equal(instance.terminated, false, 'only our explicit channel may finish the file')
  instance.onmessage({ data: { channel: 'astaria-document-v1', type: 'progress', title: '正在读取 PDF · 1/1 页' } })
  assert.deepEqual(stages, ['正在读取 PDF · 1/1 页'])
  controller.abort()
  await assert.rejects(pending, /已取消读取文档/)
  assert.equal(instance.terminated, true)
  assert.equal(instance.onmessage, null)
})
