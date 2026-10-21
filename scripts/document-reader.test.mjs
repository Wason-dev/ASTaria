/** Synthetic documents and pure Node parser tests. No browser, app DB or keys. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import * as XLSX from 'xlsx'
import { createCanvas, loadImage, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'
import { DOCUMENT_MAX_BYTES, DOCUMENT_MIME, assertDocumentSize, documentFormat, documentSummary, documentContext, projectDocumentAttachment } from '../src/xixi/documentAttachment.ts'
import { createPendingChatRequestStore } from '../src/xixi/pendingChatRequest.ts'
import { readChatAttachment } from '../src/xixi/chatAttachments.ts'

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'artifacts/task-collections-2026-10-20/documents')
// Vite's three static asset globs are the only build-time primitive replaced.
// All parser code and bundled binary/font assets below are the real installed ones.
const readerURL = pathToFileURL(resolve(root, 'src/xixi/documentReader.ts')).href
const unhook = registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context)
  if (url !== readerURL) return loaded
  const source = String(loaded.source).replace(/import\.meta\.glob\('([^']+)'[^\n]+?\) as Record<string, string>/gu, (_, pattern) => {
    const directory = pattern.slice(0, pattern.lastIndexOf('/')), files = readdirSync(resolve(root, `.${directory}`))
    const extensions = pattern.includes('bcmap') ? /\.bcmap$/u : pattern.includes('pfb') ? /\.(pfb|ttf)$/u : /\.(wasm|js)$/u
    return JSON.stringify(Object.fromEntries(files.filter(file => extensions.test(file)).map(file => [`${directory}/${file}`, pathToFileURL(resolve(root, `.${directory}`, file)).href])))
  })
  return { ...loaded, source }
} })
const { readDocument, inspectOfficeArchive, wordHtmlSections, PDF_MAX_IMAGE_PIXELS } = await import(readerURL)
unhook.deregister()

const previousFetch = globalThis.fetch
// Only package-local static resources can be fetched by the parser tests.
globalThis.fetch = async value => {
  const url = new URL(value)
  assert.equal(url.protocol, 'file:')
  const path = fileURLToPath(url)
  assert.ok(path.startsWith(resolve(root, 'node_modules/pdfjs-dist') + '/'))
  return new Response(await readFile(path))
}
// Native Skia canvas supplies actual pixels/JPEG encoding, not placeholder bytes.
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D })
globalThis.OffscreenCanvas = class {
  constructor(width, height) {
    const canvas = createCanvas(width, height)
    canvas.convertToBlob = async ({ type, quality }) => new Blob([await canvas.encode(type === 'image/jpeg' ? 'jpeg' : 'png', Math.round((quality ?? .9) * 100))], { type })
    return canvas
  }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const originals = new Map()
const file = (bytes, name) => new File([bytes], name, { type: DOCUMENT_MIME[documentFormat(name)] })

function pdf(objects) {
  const chunks = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'binary')], offsets = [0]
  let size = chunks[0].length
  objects.forEach((object, index) => {
    offsets.push(size)
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(object) ? object : Buffer.from(object), Buffer.from('\nendobj\n')])
    chunks.push(chunk); size += chunk.length
  })
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`
  return Buffer.concat([...chunks, Buffer.from(xref)])
}
const stream = (content, options = '') => { const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content); return Buffer.concat([Buffer.from(`<< /Length ${bytes.length} ${options} >>\nstream\n`), bytes, Buffer.from('\nendstream')]) }
const escape = text => text.replace(/[\\()]/gu, '\\$&')
function textPdf(lines) {
  const content = `BT /F1 7 Tf 5.5 TL 40 760 Td ${lines.map((line, i) => `${i ? 'T* ' : ''}(${escape(line)}) Tj`).join('\n')} ET`
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream(content)])
}
function scanPdf(jpeg, header = '', width = 800, height = 1000) {
  if (width !== 800 || height !== 1000) {
    jpeg = Buffer.from(jpeg)
    // PDF.js trusts JPEG SOF dimensions over conflicting PDF dictionary sizes.
    // Change the SOF too, without ever allocating the enormous pixel buffer.
    let found = false
    for (let at = 2; at + 9 < jpeg.length;) {
      const marker = jpeg[at + 1]
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { jpeg.writeUInt16BE(height, at + 5); jpeg.writeUInt16BE(width, at + 7); found = true; break }
      at += 2 + jpeg.readUInt16BE(at + 2)
    }
    assert.equal(found, true)
  }
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Scan 4 0 R >> /Font << /F1 6 0 R >> >> /Contents 5 0 R >>', stream(jpeg, `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`), stream(`q 560 0 0 700 25 30 cm /Scan Do Q\n${header ? `BT /F1 12 Tf 30 760 Td (${escape(header)}) Tj ET` : ''}`), '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'])
}
async function fixtures() {
  await mkdir(output, { recursive: true })
  const canvas = createCanvas(800, 1000), ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 800, 1000); ctx.fillStyle = '#18242e'; ctx.font = '36px sans-serif'
  ctx.fillText('Synthetic scanned page', 45, 100); ctx.font = '26px sans-serif'
  ctx.fillText('SCAN-ONLY-4821', 45, 170); ctx.fillText('No embedded OCR text.', 45, 225)
  ctx.fillStyle = '#b79a61'; ctx.fillRect(45, 285, 480, 130)
  const jpeg = await canvas.encode('jpeg', 92)
  const longLines = Array.from({ length: 120 }, (_, i) => `ROW-${String(i + 1).padStart(3, '0')} Full original page text retained beyond 6000 characters. VALUE-${i + 1}.`)
  const files = {
    'client-synthetic-text.pdf': textPdf(['Synthetic PDF document', 'PAGE-ONE-ALPHA-1739', 'Task: prepare the sample report.']),
    'client-synthetic-long-page.pdf': textPdf(longLines),
    'client-synthetic-scan.pdf': scanPdf(jpeg),
    'client-synthetic-mixed-scan.pdf': scanPdf(jpeg, 'Long header exists but the task is inside the scanned image'),
    'client-synthetic-corrupt-scan.pdf': scanPdf(Buffer.from('not a JPEG image')),
    'client-synthetic-over-40mp.pdf': scanPdf(jpeg, '', 8001, 5000),
    'client-synthetic-over-40mp-with-text.pdf': scanPdf(jpeg, 'Text header must not hide the oversized image', 8001, 5000),
    'client-synthetic-two-pages.pdf': pdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', stream('BT /F1 16 Tf 40 740 Td (PAGE ONE MARKER) Tj ET'), stream('BT /F1 16 Tf 40 740 Td (PAGE TWO MARKER) Tj ET')]),
    'client-synthetic.csv': Buffer.from('名称,备注,数量\r\n合成项目,"含逗号,保留原文",2\r\n下一项,"跨行\n第二行",3\r\n公式样文,=SUM(C2:C3),未执行\r\n'),
    'client-synthetic.tsv': Buffer.from('代码\t说明\t数值\n0012\t中文与前导零\t10\n0013\t=1+2\t20\n'),
  }
  const docx = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>合成 Word 正文 ALPHA-2468</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>任务</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>截止</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>样例报告</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026-10-25</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>末尾段 OMEGA-9753</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
  }
  files['client-synthetic.docx'] = zipSync(Object.fromEntries(Object.entries(docx).map(([name, text]) => [name, strToU8(text)])))
  const workbook = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([['合成任务', '数量', '结果'], ['样例甲', 12, 24], ['样例乙', 3]])
  sheet.C2 = { t: 'n', f: 'B2*2', v: 24 }; sheet.C3 = { t: 'n', f: 'B2+B3' }
  sheet['!ref'] = 'A1:C3'; sheet['!merges'] = [{ s: { r: 4, c: 0 }, e: { r: 4, c: 2 } }]
  XLSX.utils.book_append_sheet(workbook, sheet, '任务表')
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['隐藏数据', 'HIDDEN-3141']]), '隐藏表')
  workbook.Workbook = { Sheets: [{ name: '任务表', Hidden: 0 }, { name: '隐藏表', Hidden: 1 }] }
  files['client-synthetic.xlsx'] = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  // SheetJS's BIFF writer writes cached numbers without formula tokens. Add a
  // real BIFF8 FORMULA record for C2 so the XLS reader is tested against a
  // genuine formula, rather than treating the writer's limitation as a pass.
  const cfb = XLSX.CFB.read(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }), { type: 'buffer' })
  const entry = XLSX.CFB.find(cfb, '/Workbook'), original = Buffer.from(entry.content)
  let position = -1, recordSize = 0
  for (let at = 0; at + 4 <= original.length;) {
    const id = original.readUInt16LE(at), size = original.readUInt16LE(at + 2)
    if (id === 0x0203 && original.readUInt16LE(at + 4) === 1 && original.readUInt16LE(at + 6) === 2) { position = at; recordSize = size + 4; break }
    at += size + 4
  }
  assert.ok(position >= 0, 'BIFF numeric cache record for C2')
  const tokens = Buffer.from([0x44, 0x01, 0x00, 0x01, 0xc0, 0x1e, 0x02, 0x00, 0x05])
  const formula = Buffer.alloc(4 + 22 + tokens.length)
  formula.writeUInt16LE(0x0006); formula.writeUInt16LE(22 + tokens.length, 2)
  original.copy(formula, 4, position + 4, position + 18)
  formula.writeUInt16LE(tokens.length, 24); tokens.copy(formula, 26)
  const patched = Buffer.concat([original.subarray(0, position), formula, original.subarray(position + recordSize)])
  const delta = formula.length - recordSize
  for (let at = 0; at < position;) {
    const id = patched.readUInt16LE(at), size = patched.readUInt16LE(at + 2)
    if (id === 0x0085 && patched.readUInt32LE(at + 4) > position) patched.writeUInt32LE(patched.readUInt32LE(at + 4) + delta, at + 4)
    at += size + 4
  }
  XLSX.CFB.utils.cfb_add(cfb, '/Workbook', patched)
  files['client-synthetic.xls'] = XLSX.CFB.write(cfb, { type: 'buffer' })
  for (const [name, bytes] of Object.entries(files)) { originals.set(name, bytes); await writeFile(resolve(output, name), bytes) }
  const manifest = { syntheticOnly: true, generatedBy: 'scripts/document-reader.test.mjs', files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: hash(bytes) })), longPageRows: 120, scanMarker: 'SCAN-ONLY-4821', notes: ['PDF text/long/scan/mixed-header scan; scan text is pixels only, no OCR.', 'Word contains paragraphs and a 2x2 table.', 'Excel contains cached and uncached formulas, a merged range and a hidden sheet.', 'CSV/TSV contain Chinese, leading zeros, quotes and multiline cells.'] }
  await writeFile(resolve(output, 'client-synthetic-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
}
await fixtures()
const results = []
async function parse(name) {
  const progress = [], bytes = originals.get(name)
  const attachment = await readDocument(file(bytes, name), title => progress.push(title))
  assert.equal(attachment.size, bytes.length)
  assert.equal(hash(Buffer.from(attachment.data.split(',')[1], 'base64')), hash(bytes))
  assert.ok(progress.length >= 1)
  results.push({ name, sections: attachment.document.sections.length, characters: attachment.document.sections.reduce((n, s) => n + s.text.length, 0), images: attachment.document.sections.filter(s => s.image).length, warnings: attachment.document.warnings, progress })
  return attachment
}

test('real PDF text is page-addressable and a >6000 character page stays complete', async () => {
  const simple = await parse('client-synthetic-text.pdf')
  assert.equal(simple.document.sections[0].label, '第 1 页')
  assert.match(simple.document.sections[0].text, /PAGE-ONE-ALPHA-1739/u)
  const long = await parse('client-synthetic-long-page.pdf'), section = long.document.sections[0]
  assert.equal(long.document.sections.length, 1); assert.ok(section.text.length > 6000)
  assert.match(section.text, /ROW-001/u); assert.match(section.text, /ROW-120/u)
  assert.match(documentContext(long), /尚未读完/u)
  const multi = await parse('client-synthetic-two-pages.pdf')
  assert.deepEqual(multi.document.sections.map(s => s.label), ['第 1 页', '第 2 页'])
  assert.match(multi.document.sections[1].text, /PAGE TWO MARKER/u)
})

test('real scan and scan-with-text-header produce decodable, nonblank JPEGs without invented OCR', async () => {
  for (const name of ['client-synthetic-scan.pdf', 'client-synthetic-mixed-scan.pdf']) {
    const attachment = await parse(name), section = attachment.document.sections[0]
    assert.equal(section.image.mime, 'image/jpeg')
    const bytes = Buffer.from(section.image.data.split(',')[1], 'base64')
    assert.equal(bytes.length, section.image.size); assert.equal(bytes.readUInt16BE(0), 0xffd8)
    const decoded = await loadImage(bytes); assert.ok(decoded.width >= 1000); assert.ok(decoded.height <= 1800)
    const canvas = createCanvas(decoded.width, decoded.height), ctx = canvas.getContext('2d'); ctx.drawImage(decoded, 0, 0)
    const pixels = ctx.getImageData(0, 0, decoded.width, decoded.height).data
    let dark = 0, bright = 0
    for (let i = 0; i < pixels.length; i += 4) { if (pixels[i] < 100) dark++; if (pixels[i] > 240) bright++ }
    assert.ok(dark > 500); assert.ok(bright > 500)
    assert.doesNotMatch(section.text, /SCAN-ONLY-4821/u)
    assert.match(attachment.document.warnings.join(' '), /未执行 OCR/u)
    await writeFile(resolve(output, name.replace('.pdf', '-page.jpg')), bytes)
  }
})

test('real browser Mammoth reads Word paragraphs and table coordinates in source order', async () => {
  const parsed = await parse('client-synthetic.docx'), sections = parsed.document.sections
  assert.match(sections[0].text, /ALPHA-2468/u)
  assert.match(sections[1].label, /表 1/u); assert.match(sections[1].text, /R1C1: 任务/u)
  assert.match(sections[2].text, /R2C2: 2026-10-25/u)
  assert.match(sections.at(-1).text, /OMEGA-9753/u)
})

test('XLSX and XLS retain worksheets, coordinates, merged ranges and formula/cache provenance', async () => {
  for (const name of ['client-synthetic.xlsx', 'client-synthetic.xls']) {
    const parsed = await parse(name), text = parsed.document.sections.map(s => `${s.label}\n${s.text}`).join('\n')
    assert.match(text, /任务表/u); assert.match(text, /B2: 12/u); assert.match(text, /公式 =B2\*2；缓存结果：24/u)
    assert.match(text, /隐藏表/u); assert.match(text, /HIDDEN-3141/u); assert.match(text, /A5:C5/u)
    assert.equal(documentSummary(parsed), '表格 · 2 张工作表')
    if (name.endsWith('.xlsx')) assert.match(text, /没有缓存结果，未计算/u)
    assert.match(parsed.document.warnings.join(' '), /未执行公式/u)
  }
})

test('CSV/TSV preserve UTF-8 Chinese, quoted multiline values, leading zeros and literal formulas', async () => {
  const csv = await parse('client-synthetic.csv'), csvText = csv.document.sections.map(s => s.text).join('\n')
  assert.match(csvText, /A2: 合成项目/u); assert.match(csvText, /含逗号,保留原文/u); assert.match(csvText, /跨行\n第二行/u)
  assert.match(csvText, /B4: =SUM\(C2:C3\)/u); assert.doesNotMatch(csvText, /\[公式/u)
  const tsv = await parse('client-synthetic.tsv'), tsvText = tsv.document.sections.map(s => s.text).join('\n')
  assert.match(tsvText, /A2: 0012/u); assert.match(tsvText, /中文与前导零/u); assert.match(tsvText, /B3: =1\+2/u)
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('名字\t值\n测试\t001\n', 'utf16le')])
  const parsed = await readDocument(file(utf16, 'utf16.tsv')); assert.match(parsed.document.sections[0].text, /测试/u)
})

test('empty, mismatched, oversized, old .doc and invalid encoding fail explicitly before returning partial content', async () => {
  assert.doesNotThrow(() => assertDocumentSize(DOCUMENT_MAX_BYTES))
  await assert.rejects(readDocument(file(Buffer.alloc(0), 'empty.pdf')), /为空/u)
  await assert.rejects(readDocument(file(originals.get('client-synthetic-corrupt-scan.pdf'), 'corrupt.pdf')), /图片未能完整解码|图像|JPEG|Jpeg/u)
  let accessed = false
  await assert.rejects(readDocument({ name: 'large.pdf', size: DOCUMENT_MAX_BYTES + 1, arrayBuffer() { accessed = true; throw Error('must not read') } }), /10 MiB/u)
  assert.equal(accessed, false)
  await assert.rejects(readDocument(file(Buffer.from('not a pdf'), 'bad.pdf')), /有效的 PDF/u)
  await assert.rejects(readDocument(file(Buffer.from('bad'), 'old.doc')), /另存为/u)
  await assert.rejects(readDocument(file(Buffer.from([0xff, 0xff, 0x0a]), 'invalid.csv')), /编码无法识别/u)
  const wrong = zipSync({ 'not-office.xml': strToU8('not a Word file') })
  assert.throws(() => inspectOfficeArchive(wrong, 'docx'), /扩展名不一致/u)
  const bomb = zipSync({ 'word/document.xml': new Uint8Array(25 * 1024 * 1024) })
  assert.throws(() => inspectOfficeArchive(bomb, 'docx'), /展开后过大/u)
})

test('PDF rejects >40MP image declarations before canvas allocation, including pages with valid text', async () => {
  assert.equal(PDF_MAX_IMAGE_PIXELS, 40_000_000)
  const NativeOffscreen = globalThis.OffscreenCanvas
  let canvases = 0
  globalThis.OffscreenCanvas = class { constructor() { canvases++; throw Error('oversized image must fail before allocating a page canvas') } }
  try {
    for (const name of ['client-synthetic-over-40mp.pdf', 'client-synthetic-over-40mp-with-text.pdf']) {
      const bytes = originals.get(name)
      assert.ok(bytes.length < DOCUMENT_MAX_BYTES)
      await assert.rejects(readDocument(file(bytes, name)), /超过 4000 万像素.*未发送空白替代页/u)
    }
    assert.equal(canvases, 0)
  } finally { globalThis.OffscreenCanvas = NativeOffscreen }
})

test('Word data-only HTML extraction retains entities and full long paragraphs without executing markup', () => {
  const long = '完整原文'.repeat(1700)
  const result = wordHtmlSections(`<p>${long}</p><table><tr><td>A &amp; B</td><td>下一格</td></tr></table><p>&lt;script&gt;data only&lt;/script&gt;</p>`)
  assert.equal(result[0].text, long); assert.match(result[1].text, /R1C1: A & B/u)
  assert.equal(result[2].text, '<script>data only</script>')
  const merged = wordHtmlSections('<table><tr><td rowspan="2">合并</td><td>上</td></tr><tr><td>下</td></tr></table>')
  assert.match(merged[1].text, /R2C2: 下/u)
})

test('durable retry projects allowed fields while retaining exact original, page text, images and warnings through reload', async () => {
  const doc = await parse('client-synthetic-mixed-scan.pdf')
  doc.document.sections[0].text += '\n' + '长页'.repeat(3500)
  const clean = structuredClone(doc), polluted = structuredClone(doc)
  polluted.provider = { apiKey: 'synthetic-not-a-key' }; polluted.document.extra = 'do not store'
  polluted.document.sections[0].extra = 'do not store'; polluted.document.sections[0].image.extra = 'do not store'
  const sessionValues = new Map(), records = new Map()
  const session = { getItem: k => sessionValues.get(k) ?? null, setItem: (k, v) => sessionValues.set(k, v) }
  const adapter = { async list() { return [...records.values()].map(value => structuredClone(value)) }, async put(scope, record) { records.set(record.requestId, structuredClone(record)) }, async remove(scope, ids) { for (const id of ids) records.delete(id) } }
  const options = { session, adapter, createId: () => 'synthetic-document-scope' }, store = createPendingChatRequestStore(options)
  const request = { requestId: 'synthetic-document-retry', conversationId: 'synthetic-chat', text: 'read this document', context: { page: 'home', timezone: 'Asia/Shanghai' }, attachments: [polluted] }
  await store.save(request)
  const restored = (await createPendingChatRequestStore(options).list())[0]
  assert.deepEqual(restored.attachments[0], clean)
  assert.ok(!JSON.stringify([...records.values()]).includes('do not store'))
  assert.ok(!JSON.stringify([...sessionValues.values()]).includes('data:application/pdf'))
  await store.save({ ...request, attachments: [clean] })
  await assert.rejects(store.save({ ...request, attachments: [{ ...clean, document: { ...clean.document, sections: [] } }] }), /不完整/u)
  await store.remove([request.requestId]); assert.equal((await store.list()).length, 0)
})

test('worker progress, cancellation, errors and uncloneable messages always release the dedicated worker', async t => {
  const previous = globalThis.Worker, workers = []
  globalThis.Worker = class {
    constructor(url, options) { assert.ok(url.href.endsWith('documentReader.worker.ts')); assert.equal(options.type, 'module'); workers.push(this) }
    terminate() { this.terminated = true }
    postMessage() { if (this.failPost) throw Error('clone failed') }
  }
  t.after(() => { if (previous) globalThis.Worker = previous; else delete globalThis.Worker })
  const sample = file(originals.get('client-synthetic-text.pdf'), 'client-synthetic-text.pdf'), controller = new AbortController(), progress = []
  const pending = readChatAttachment(sample, { signal: controller.signal, onProgress: title => progress.push(title) })
  const worker = workers.at(-1); worker.onmessage({ data: { channel: 'astaria-document-v1', type: 'progress', title: '正在读取 PDF · 1/1 页' } }); controller.abort()
  await assert.rejects(pending, /取消/u); assert.equal(worker.terminated, true); assert.equal(worker.onmessage, null); assert.equal(progress.length, 1)
  const successful = readChatAttachment(sample), second = workers.at(-1), doc = await readDocument(sample)
  second.onmessage({ data: { channel: 'astaria-document-v1', type: 'done', attachment: doc } }); assert.deepEqual(await successful, doc); assert.equal(second.terminated, true)
  const failed = readChatAttachment(sample), third = workers.at(-1); third.onmessageerror(); await assert.rejects(failed, /传输失败/u); assert.equal(third.terminated, true)
  const originalPost = globalThis.Worker.prototype.postMessage
  globalThis.Worker.prototype.postMessage = () => { throw Error('clone failed') }
  await assert.rejects(readChatAttachment(sample), /clone failed/u); assert.equal(workers.at(-1).terminated, true)
  globalThis.Worker.prototype.postMessage = originalPost
  const aborted = new AbortController(); aborted.abort(); const count = workers.length
  await assert.rejects(readChatAttachment(sample, { signal: aborted.signal }), /取消/u); assert.equal(workers.length, count)
})

test.after(async () => {
  globalThis.fetch = previousFetch
  await writeFile(resolve(output, 'client-reader-results.json'), JSON.stringify({ environment: 'Node 24 + installed parsers + native Skia OffscreenCanvas compatibility shim; no browser', results }, null, 2) + '\n')
})
