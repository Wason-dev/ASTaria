import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync, inflateSync } from 'node:zlib'
import { planTimetableCrops, prepareTimetableImages, TIMETABLE_MAX_IMAGE_BYTES, timetableCodeGroups, timetableGroupQuestions, matchTimetableRows, timetableAmbiguousIds, timetableNeedsReview, applyTimetablePeriodTimes } from '../src/planner/timetableImportImages.ts'
import { readChatImage } from '../src/xixi/chatAttachments.ts'
import { inspectChatImage } from '../src/xixi/chatImagePolicy.ts'
import { normalizeChatAttachments } from '../server/chatAttachments.mjs'

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0)
  return n >>> 0
})
function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length); out.write(type, 4); out.set(data, 8)
  let crc = 0xffffffff
  for (const byte of out.subarray(4, -4)) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4)
  return out
}
function png(width, height, pixels, paddedSize) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8
  const scan = Buffer.alloc((width + 1) * height)
  for (let y = 0; y < height; y++) scan.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1)
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]
  if (paddedSize) {
    const length = parts.reduce((n, part) => n + part.length, 0)
    const text = Buffer.alloc(paddedSize - length - 12, 65); text.write('Padding\0')
    parts.splice(-1, 0, chunk('tEXt', text))
  }
  return Buffer.concat(parts)
}
function pixelsOf(bytes) {
  const { width, height } = inspectChatImage(bytes), idat = []
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + size))
    offset += size + 12
  }
  const scan = inflateSync(Buffer.concat(idat)), pixels = Buffer.alloc(width * height)
  for (let y = 0; y < height; y++) {
    assert.equal(scan[y * (width + 1)], 0)
    pixels.set(scan.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width)
  }
  return { width, height, pixels }
}
async function fixture(width = 128, height = 192) {
  const pixels = Buffer.from(Array.from({ length: width * height }, (_, i) => (i % width * 7 + Math.floor(i / width) * 13) % 256))
  const bytes = png(width, height, pixels)
  const original = await readChatImage(new File([bytes], '原图.png', { type: 'image/png' }), { decodeImage: async () => ({ width, height }) })
  let closed = 0, rendered = 0
  const runtime = {
    decode: async () => ({ width, height, source: { width, height, pixels }, close: () => { closed++ } }),
    render: async (source, crop) => {
      rendered++
      const output = Buffer.alloc(crop.width * crop.height)
      for (const piece of crop.pieces) for (let y = 0; y < piece.height; y++) for (let x = 0; x < piece.width; x++) output[(piece.dy + y) * crop.width + piece.dx + x] = source.pixels[(piece.sy + y) * source.width + piece.sx + x]
      return new Blob([png(crop.width, crop.height, output)], { type: 'image/png' })
    },
    read: file => readChatImage(file, { decodeImage: async blob => inspectChatImage(new Uint8Array(await blob.arrayBuffer())) }),
  }
  return { width, height, pixels, original, runtime, closed: () => closed, rendered: () => rendered }
}

test('six crop plans retain top/left headers and cover all table pixels at native resolution', () => {
  const width = 1400, height = 2100, headerWidth = 110, headerHeight = 150
  const crops = planTimetableCrops(width, height, { headerWidth, headerHeight })
  assert.equal(crops.length, 6)
  const covered = new Uint8Array(width * height)
  for (const crop of crops) {
    assert.ok(crop.width <= width && crop.height <= height)
    assert.deepEqual(crop.pieces[0], { sx: 0, sy: 0, width: headerWidth, height: headerHeight, dx: 0, dy: 0 })
    assert.equal(crop.pieces.length, 4)
    for (const p of crop.pieces) {
      assert.ok(p.sx >= 0 && p.sy >= 0 && p.sx + p.width <= width && p.sy + p.height <= height)
      assert.ok(p.dx >= 0 && p.dy >= 0 && p.dx + p.width <= crop.width && p.dy + p.height <= crop.height)
      for (let y = p.sy; y < p.sy + p.height; y++) covered.fill(1, y * width + p.sx, y * width + p.sx + p.width)
    }
  }
  assert.equal(covered.every(value => value === 1), true)
})

test('original is byte-exact, PNG crops preserve pixel values and are accepted by existing attachment normalizer', async () => {
  const f = await fixture(), options = { split: true, headerWidth: 15, headerHeight: 20 }
  const images = await prepareTimetableImages(f.original, options, f.runtime)
  assert.equal(images.length, 7)
  assert.strictEqual(images[0], f.original)
  const plans = planTimetableCrops(f.width, f.height, options)
  for (let index = 0; index < plans.length; index++) {
    const attachment = images[index + 1]
    assert.equal(attachment.mime, 'image/png')
    assert.deepEqual(normalizeChatAttachments([attachment]), [attachment])
    const bytes = Buffer.from(attachment.data.split(',')[1], 'base64'), decoded = pixelsOf(bytes), crop = plans[index]
    assert.equal(decoded.width, crop.width); assert.equal(decoded.height, crop.height)
    for (const p of crop.pieces) for (let y = 0; y < p.height; y++) for (let x = 0; x < p.width; x++) assert.equal(decoded.pixels[(p.dy + y) * crop.width + p.dx + x], f.pixels[(p.sy + y) * f.width + p.sx + x])
  }
  assert.equal(f.closed(), 1)
})

test('overview-only mode does not decode or render; cancellation cannot return prepared images', async () => {
  const f = await fixture()
  const result = await prepareTimetableImages(f.original, { split: false, headerWidth: 0, headerHeight: 0 }, f.runtime)
  assert.deepEqual(result, [f.original]); assert.equal(f.closed(), 0); assert.equal(f.rendered(), 0)
  const abort = new AbortController()
  const runtime = { ...f.runtime, render: async (...args) => { const blob = await f.runtime.render(...args); abort.abort(); return blob } }
  await assert.rejects(prepareTimetableImages(f.original, { split: true, headerWidth: 10, headerHeight: 20, signal: abort.signal }, runtime), { name: 'AbortError' })
  assert.equal(f.closed(), 1)
  assert.equal(f.rendered(), 1)
})

test('invalid dimensions/headers fail, and cropped sources are closed on render failures', async () => {
  for (const [width, height, headerWidth, headerHeight] of [[0, 10, 0, 0], [9000, 10, 0, 0], [100, 100, -1, 0], [100, 100, 100, 0], [100, 100, 0, 100], [100, 100, 1.5, 0]]) assert.throws(() => planTimetableCrops(width, height, { headerWidth, headerHeight }))
  assert.ok(planTimetableCrops(1, 1, { headerWidth: 0, headerHeight: 0 }).length <= 6)
  const f = await fixture()
  await assert.rejects(prepareTimetableImages(f.original, { split: true, headerWidth: 10, headerHeight: 20 }, { ...f.runtime, render: async () => { throw new Error('no canvas') } }), /no canvas/u)
  assert.equal(f.closed(), 1)
  await assert.rejects(prepareTimetableImages({ ...f.original, size: 1 }, { split: false, headerWidth: 0, headerHeight: 0 }, f.runtime), /不一致/u)
})

test('aggregate byte budget stops preparation without resizing, retrying or sending anything', async () => {
  const f = await fixture(), large = png(1, 1, Buffer.from([1]), 10 * 1024 * 1024)
  assert.equal(TIMETABLE_MAX_IMAGE_BYTES, 20 * 1024 * 1024)
  let calls = 0
  const runtime = { ...f.runtime, render: async () => { calls++; return new Blob([large], { type: 'image/png' }) } }
  await assert.rejects(prepareTimetableImages(f.original, { split: true, headerWidth: 10, headerHeight: 20 }, runtime), /20 MiB/u)
  assert.equal(calls, 2)
  assert.equal(f.closed(), 1)
})

test('rotated decoder dimensions are used consistently, with all resources released', async () => {
  const f = await fixture(100, 150)
  const rotated = { width: f.height, height: f.width, pixels: Buffer.alloc(f.width * f.height) }
  let closed = false
  const images = await prepareTimetableImages(f.original, { split: true, headerWidth: 10, headerHeight: 10 }, { ...f.runtime,
    decode: async () => ({ source: rotated, width: rotated.width, height: rotated.height, close: () => { closed = true } }),
  })
  assert.equal(images.length, 7)
  assert.equal(closed, true)
})

const lesson = (id, subject, weekday, period, classGroup = '', patch = {}) => ({ id, subject, subjectGroup: subject.match(/^[A-Za-z]+/u)?.[0] ?? '', weekday, period, classGroup, location: '', start: '08:00', end: '08:40', weekCycle: 'weekly', note: '', ...patch })

test('deduplicate exact codes for chips without merging digits, case, Phy/Phi or spaces', () => {
  const subjects = ['Econ1', 'Econ2', 'Bus1', 'Bus2', 'Phy1', 'Phi1', 'phy1', ' Econ1 ']
  const rows = subjects.flatMap((subject, index) => [lesson(`${index}a`, subject, 1, '2'), lesson(`${index}b`, subject, 3, '5')])
  assert.deepEqual(timetableCodeGroups(rows).flatMap(group => group.codes), subjects)
  assert.deepEqual(matchTimetableRows(rows, new Set(['Econ1']), {}).map(row => row.id), ['0a', '0b'])
})

test('letter groups are per code and only for same-slot duplicates; lone CS1 B and ESS2 A need no question', () => {
  const rows = [lesson('bus-a', 'Bus1', 1, '2', 'A'), lesson('bus-b', 'Bus1', 1, '2', 'B'),
    lesson('econ-e', 'Econ1', 1, '2', 'E'), lesson('econ-f', 'Econ1', 1, '2', 'F'),
    lesson('cs-b', 'CS1', 1, '8', 'B'), lesson('ess-a', 'ESS2', 1, '8', 'A'),
    lesson('bus-th-a', 'Bus1', 4, '9', 'A'), lesson('bus-th-b', 'Bus1', 4, '9', 'B')]
  const codes = new Set(['Bus1', 'Econ1', 'CS1', 'ESS2']), questions = timetableGroupQuestions(rows, codes)
  assert.equal(questions.length, 2)
  const bus = questions.find(question => question.subjects.includes('Bus1')), econ = questions.find(question => question.subjects.includes('Econ1'))
  assert.deepEqual(bus.options, ['A', 'B']); assert.deepEqual(econ.options, ['E', 'F'])
  assert.deepEqual(matchTimetableRows(rows, codes, { [bus.id]: 'A', [econ.id]: 'F' }).map(row => row.id), ['bus-a', 'econ-f', 'cs-b', 'ess-a', 'bus-th-a'])
})

test('Eng/L&L/Lit numbered groups share one explicit answer all week, independent of letters and gender', () => {
  const rows = [lesson('eng-m1', 'Eng', 1, '6', '分组1'), lesson('eng-m2', 'Eng', 1, '6', '分组2'),
    lesson('eng-tu1', 'Eng', 2, '7', '分组1'), lesson('eng-tu2', 'Eng', 2, '7', '分组2'),
    lesson('lang1', 'L&L', 4, '8', '分组1'), lesson('lit2', 'Lit', 4, '8', '分组2'),
    lesson('pe-m', '体育与健康', 5, '6', '男生'), lesson('pe-f', '体育与健康', 5, '6', '女生')]
  const codes = new Set(['Eng', 'L&L', 'Lit', '体育与健康']), questions = timetableGroupQuestions(rows, codes)
  assert.equal(questions.length, 2)
  const language = questions.find(question => question.family === '分组'), gender = questions.find(question => question.family === '男生 / 女生')
  assert.deepEqual(language.options, ['分组1', '分组2'])
  assert.deepEqual(matchTimetableRows(rows, codes, { [language.id]: '分组2', [gender.id]: '女生' }).map(row => row.id), ['eng-m2', 'eng-tu2', 'lit2', 'pe-f'])
})

test('different rooms without labels retain all alternatives and explicitly need manual disambiguation', () => {
  const rows = [lesson('one', 'Econ2', 1, '3', '', { location: '101' }), lesson('two', 'Econ2', 1, '3', '', { location: '102' })]
  const codes = new Set(['Econ2'])
  assert.deepEqual(timetableGroupQuestions(rows, codes), [])
  assert.equal(matchTimetableRows(rows, codes, {}).length, 2)
  assert.deepEqual([...timetableAmbiguousIds(rows)], ['one', 'two'])
  assert.equal(timetableAmbiguousIds(rows.slice(0, 1)).size, 0)
})

test('bulk period correction applies exact period across week without joining real breaks or resolving unknown cells', () => {
  const rows = [lesson('a', 'Chem1', 2, '4', '', { start: '', end: '', uncertain: true }),
    lesson('b', 'Chem1', 2, '5', '', { start: '', end: '', uncertain: true }),
    lesson('c', 'Bus1', 5, '4', '', { start: '', end: '' }), lesson('unknown', '', null, '', '', { uncertain: true, cell: '未知格子' })]
  const corrected = applyTimetablePeriodTimes(applyTimetablePeriodTimes(rows, '4', '10:20', '11:00'), '5', '11:05', '11:55')
  assert.deepEqual(corrected.slice(0, 3).map(row => [row.start, row.end]), [['10:20', '11:00'], ['11:05', '11:55'], ['10:20', '11:00']])
  assert.equal(corrected[0].uncertain, true, 'time correction cannot pretend all cell fields are reviewed')
  assert.equal(timetableNeedsReview(corrected[3]), true)
  assert.deepEqual(rows[0].start, '', 'original draft remains unmutated')
  assert.throws(() => applyTimetablePeriodTimes(rows, '4', '1:30', '2:10'))
  assert.throws(() => applyTimetablePeriodTimes(rows, '4', '14:00', '13:00'))
})
