import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'
import { normalizeChatAttachments } from '../server/chatAttachments.mjs'
import { contextUnits } from '../server/contextBudget.mjs'
import { CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_EDGE, CHAT_IMAGE_MAX_PIXELS, CHAT_IMAGE_MAX_BASE64_LENGTH, inspectChatImage } from '../src/xixi/chatImagePolicy.ts'

const settings = {
  provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: false,
  contextBudget: { mode: 'auto', maxUnits: 48_000 }, webSearch: { enabled: false, maxUses: 2 },
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-vl:8b' },
}

// Real 2 × 3 images generated and decoded offline. These independent Base64
// constants are copied from chat-attachments-client.test.mjs on purpose: this
// file must not import that module, because importing it would register its
// tests a second time.
const fixtures = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOMatrCwMDAxAAGUAoAHaoBllxQ+i0AAAAASUVORK5CYII=',
  jpeg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCOiiivcPKP/9k=',
  webp: 'UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAMAAUAmJZgCdLoAA5gA/su3/8Q50OdDl/7+tr23hhQAAAA=',
}
const png = Buffer.from(fixtures.png, 'base64')
const jpeg = Buffer.from(fixtures.jpeg, 'base64')
const webp = Buffer.from(fixtures.webp, 'base64')

// Same padded-PNG helper as the client test: a complete PNG whose final size is
// exact, padded with a valid 0-terminated tEXt keyword chunk.
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
function paddedPng(size) {
  const text = Buffer.alloc(size - png.length - 12, 'p')
  Buffer.from('Padding\0').copy(text)
  return Buffer.concat([png.subarray(0, -12), pngChunk('tEXt', text), png.subarray(-12)])
}
const serverImage = (bytes, mime = 'image/png') => ({ name: '原图.png', mime, size: bytes.length, data: `data:${mime};base64,${bytes.toString('base64')}` })
const dataUrl = (mime, encoded) => `data:${mime};base64,${encoded}`

test('chat attachments are validated, persisted locally, and sent as vision content', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  saveModelSettings(db, settings)
  const requests = []
  const xixi = createXixi({ db, complete: async payload => {
    requests.push(payload)
    return { choices: [{ message: { role: 'assistant', content: '我看到了这张图片。' } }] }
  } })
  const data = dataUrl('image/png', fixtures.png)
  const attachment = { name: '课表.png', mime: 'image/png', size: png.length, data }
  const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '', attachments: [attachment], context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(result.status, 'completed')
  const user = result.messages.find(message => message.role === 'user')
  assert.equal(user.attachments[0].name, '课表.png')
  assert.equal(user.attachments[0].size, png.length)
  assert.equal(user.attachments[0].data, data)
  const content = requests[0].messages.find(message => message.role === 'user').content
  assert.deepEqual(content, [{ type: 'text', text: '请识别这张图片' }, { type: 'image_url', image_url: { url: data } }])
})

test('image bytes use a bounded multimodal budget instead of their Base64 length', () => {
  const bytes = paddedPng(3 * 1024 * 1024), data = dataUrl('image/png', bytes.toString('base64'))
  // The same bytes counted as plain text would consume ~1.4 million units.
  const units = contextUnits([{ role: 'user', content: [{ type: 'text', text: '识别图片' }, { type: 'image_url', image_url: { url: data } }] }])
  assert.ok(units < 2_000, `image budget unexpectedly grew to ${units} text units`)
  const normalized = normalizeChatAttachments([{ name: 'large.png', mime: 'image/png', size: bytes.length, data }])
  assert.equal(normalized[0].size, bytes.length)
  assert.equal(normalized[0].data, data)
})

test('unsupported or oversized images are rejected before a model request', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  saveModelSettings(db, settings)
  let calls = 0
  const xixi = createXixi({ db, complete: async () => {
    calls++
    return { choices: [{ message: { role: 'assistant', content: '不应被调用。' } }] }
  } })
  const chat = attachments => xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '', attachments, context: { page: 'home', timezone: 'Asia/Shanghai' } })
  await assert.rejects(chat([{ name: 'x.gif', mime: 'image/gif', size: 1, data: 'data:image/gif;base64,eA==' }]), /仅支持/u)
  assert.throws(() => normalizeChatAttachments([{ name: 'x.gif', mime: 'image/gif', size: 1, data: 'data:image/gif;base64, eA==' }]), /仅支持/u)
  await assert.rejects(chat([serverImage(paddedPng(CHAT_IMAGE_MAX_BYTES + 1))]), /不能超过 10 MiB/u)
  assert.equal(calls, 0)
})

test('real PNG, JPEG and WebP bytes are normalized one image per message', () => {
  for (const [mime, bytes] of [['image/png', png], ['image/jpeg', jpeg], ['image/webp', webp]]) {
    const normalized = normalizeChatAttachments([serverImage(bytes, mime)])[0]
    assert.equal(normalized.name, '原图.png')
    assert.equal(normalized.mime, mime)
    assert.equal(normalized.size, bytes.length)
    assert.equal(normalized.data, dataUrl(mime, bytes.toString('base64')))
    // A missing size is filled with the real byte count instead of being trusted.
    const { size, ...withoutSize } = serverImage(bytes, mime)
    assert.equal(normalizeChatAttachments([withoutSize])[0].size, bytes.length)
  }
  assert.equal(normalizeChatAttachments(undefined), undefined)
  assert.throws(() => normalizeChatAttachments([serverImage(png), serverImage(jpeg)]), /最多附带一张图片/u)
  assert.deepEqual([...new Set([png, jpeg, webp].map(bytes => inspectChatImage(bytes).mime))], ['image/png', 'image/jpeg', 'image/webp'])
})

test('original bytes up to 10 MiB are kept untouched and one more byte is rejected', () => {
  const exact = paddedPng(CHAT_IMAGE_MAX_BYTES), lower = paddedPng(2 * 1024 * 1024 + 1)
  assert.equal(exact.length, CHAT_IMAGE_MAX_BYTES)
  assert.equal(inspectChatImage(exact).mime, 'image/png')
  const normalized = normalizeChatAttachments([serverImage(exact)])[0]
  assert.equal(normalized.size, CHAT_IMAGE_MAX_BYTES)
  assert.equal(normalized.data, dataUrl('image/png', exact.toString('base64')))
  assert.equal(normalizeChatAttachments([serverImage(lower)])[0].size, lower.length)
  assert.throws(() => normalizeChatAttachments([serverImage(paddedPng(CHAT_IMAGE_MAX_BYTES + 1))]), /不能超过 10 MiB/u)
})

test('declared MIME, padding and size must match the real bytes', () => {
  assert.equal(CHAT_IMAGE_MAX_BYTES, 10 * 1024 * 1024)
  assert.equal(CHAT_IMAGE_MAX_EDGE, 8192)
  assert.equal(CHAT_IMAGE_MAX_PIXELS, 16_777_216)
  assert.equal(CHAT_IMAGE_MAX_BASE64_LENGTH, Math.ceil(CHAT_IMAGE_MAX_BYTES / 3) * 4)
  for (const [mime, bytes] of [['image/png', jpeg], ['image/png', webp], ['image/jpeg', png], ['image/jpeg', webp], ['image/webp', png]])
    assert.throws(() => normalizeChatAttachments([{ name: '伪装.png', mime, size: bytes.length, data: dataUrl(mime, bytes.toString('base64')) }]), /MIME 与实际格式不一致/u)
  // A wrong file extension is not evidence: the real bytes win.
  assert.equal(normalizeChatAttachments([{ name: '其实是PNG.gif', mime: 'image/png', size: png.length, data: dataUrl('image/png', fixtures.png) }])[0].size, png.length)
  assert.throws(() => normalizeChatAttachments([{ name: 'x.png', mime: 'image/png', size: png.length, data: 'data:image/jpeg;base64,' + fixtures.png }]), /内容不正确/u)
  for (const size of [1.5, 0, 1, png.length + 1, Number.MAX_SAFE_INTEGER, '77'])
    assert.throws(() => normalizeChatAttachments([{ name: 'x.png', mime: 'image/png', size, data: dataUrl('image/png', fixtures.png) }]), /大小不一致|格式不正确/u)
  assert.equal(normalizeChatAttachments([{ name: 'x.png', mime: 'image/png', data: dataUrl('image/png', fixtures.png) }])[0].size, png.length)
})

test('empty images, forged bytes, malicious headers and oversized dimensions are rejected', () => {
  assert.throws(() => normalizeChatAttachments([{ name: 'x.png', mime: 'image/png', data: dataUrl('image/png', '') }]), /不能为空/u)
  assert.throws(() => normalizeChatAttachments([serverImage(Buffer.from('small test image'))]), /仅支持/u)
  assert.throws(() => normalizeChatAttachments([serverImage(png.subarray(0, 24))]), /损坏/u)
  const crc = Buffer.from(png); crc[29] ^= 1
  assert.throws(() => normalizeChatAttachments([serverImage(crc)]), /损坏/u)
  const overflow = Buffer.from(png); overflow.writeUInt32BE(0xffffffff, 33)
  assert.throws(() => normalizeChatAttachments([serverImage(overflow)]), /损坏/u)
  const edge = Buffer.from(png); edge.writeUInt32BE(CHAT_IMAGE_MAX_EDGE + 1, 16)
  edge.writeUInt32BE(crc32(edge.subarray(12, 29)), 29)
  assert.throws(() => normalizeChatAttachments([serverImage(edge)]), /8192/u)
  const pixels = Buffer.from(png); pixels.writeUInt32BE(4097, 16); pixels.writeUInt32BE(4096, 20)
  pixels.writeUInt32BE(crc32(pixels.subarray(12, 29)), 29)
  assert.throws(() => normalizeChatAttachments([serverImage(pixels)]), /16,777,216/u)
  const truncJpeg = Buffer.from(jpeg); truncJpeg.writeUInt16BE(0, 4)
  assert.throws(() => normalizeChatAttachments([serverImage(truncJpeg, 'image/jpeg')]), /损坏/u)
  const hugeJpeg = Buffer.from(jpeg); hugeJpeg.writeUInt16BE(CHAT_IMAGE_MAX_EDGE + 1, hugeJpeg.indexOf(Buffer.from([0xff, 0xc0])) + 7)
  assert.throws(() => normalizeChatAttachments([serverImage(hugeJpeg, 'image/jpeg')]), /8192/u)
  const hugeWebp = Buffer.from(webp); hugeWebp.writeUInt16LE(CHAT_IMAGE_MAX_EDGE + 1, 26)
  assert.throws(() => normalizeChatAttachments([serverImage(hugeWebp, 'image/webp')]), /8192/u)
  const shortWebp = Buffer.from(webp); shortWebp.writeUInt32LE(0xffffffff, 16)
  assert.throws(() => normalizeChatAttachments([serverImage(shortWebp, 'image/webp')]), /损坏/u)
})

test('the Base64 string limit is checked before any Base64 decoding happens', () => {
  const original = globalThis.atob
  let decoded = 0
  globalThis.atob = value => {
    decoded++
    return original(value)
  }
  try {
    // 10 MiB + 1 bytes and exactly 10 MiB share this Base64 length, so the byte
    // estimate (not the string content) must reject the oversized one.
    const exact = paddedPng(CHAT_IMAGE_MAX_BYTES), over = paddedPng(CHAT_IMAGE_MAX_BYTES + 1)
    const exactEncoded = exact.toString('base64'), overEncoded = over.toString('base64')
    assert.equal(exactEncoded.length, overEncoded.length)
    assert.equal(overEncoded.length - overEncoded.indexOf('='), 1)
    assert.equal(exactEncoded.length, CHAT_IMAGE_MAX_BASE64_LENGTH)
    assert.throws(() => normalizeChatAttachments([{ name: 'over.png', mime: 'image/png', size: over.length, data: dataUrl('image/png', overEncoded) }]), /不能超过 10 MiB/u)
    assert.equal(decoded, 0, 'an oversized image was decoded instead of being rejected by length')
    // Fake payloads with the same Base64 length must be rejected by length alone.
    const impossible = `${'A'.repeat(CHAT_IMAGE_MAX_BASE64_LENGTH - 1)}=`
    assert.throws(() => normalizeChatAttachments([{ name: 'fake.png', mime: 'image/png', data: dataUrl('image/png', impossible + 'A') }]), /10 MiB/u)
    assert.throws(() => normalizeChatAttachments([{ name: 'fake.png', mime: 'image/png', data: dataUrl('image/png', impossible + 'AA') }]), /10 MiB/u)
    assert.equal(decoded, 0, 'an oversized Base64 string was decoded instead of being rejected by length')
    // Positive control: the spy really does see the decode calls it counts.
    assert.equal(normalizeChatAttachments([serverImage(png)])[0].size, png.length)
    assert.equal(decoded, 1)
  } finally {
    globalThis.atob = original
  }
})

test('non-canonical Base64 is rejected with a short invalid payload', () => {
  const raw = png.toString('base64')
  const short = (encoded, mime = 'image/png') => ({ name: 'x.png', mime, data: dataUrl(mime, encoded) })
  for (const encoded of [` ${raw}`, `${raw}\n`, raw.replace(/\+/g, '-').replace(/\//g, '_'), raw.replace(/=+$/u, ''), `${raw}=`, 'AA===', 'AA'])
    assert.throws(() => normalizeChatAttachments([short(encoded)]), /Base64|仅支持/u)
  const canonical = Buffer.alloc(1).toString('base64')
  assert.equal(canonical, 'AA==')
  assert.throws(() => normalizeChatAttachments([short('AB==')]), /Base64/u)
  assert.equal(Buffer.from('AA==', 'base64')[0], Buffer.from('AB==', 'base64')[0])
})

test('normalizeChatAttachments still handles real images without a global Buffer', () => {
  // Build the fixture while Buffer still exists, then take Buffer away.
  const bytes = Buffer.from(fixtures.png, 'base64'), source = serverImage(bytes)
  const data = source.data
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
  let normalized
  try {
    Object.defineProperty(globalThis, 'Buffer', { configurable: true, writable: true, value: undefined })
    assert.equal(globalThis.Buffer, undefined)
    normalized = normalizeChatAttachments([source])
    assert.throws(() => normalizeChatAttachments([{ name: 'x.gif', mime: 'image/gif', size: 1, data: 'data:image/gif;base64,eA==' }]), error => {
      assert.equal(error.name, 'ValidationError')
      assert.equal(error.status, 400)
      return /仅支持/u.test(error.message)
    })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'Buffer', descriptor)
    else delete globalThis.Buffer
  }
  assert.equal(globalThis.Buffer, Buffer)
  assert.equal(normalized[0].size, bytes.length)
  assert.equal(normalized[0].mime, 'image/png')
  assert.equal(normalized[0].data, data)
  assert.equal(normalizeChatAttachments([source])[0].data, data)
})
