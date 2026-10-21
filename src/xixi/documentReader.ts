import { unzipSync } from 'fflate'
import { parseDocument } from 'htmlparser2'
import { assertDocumentSize, DOCUMENT_MAX_IMAGE_BYTES, DOCUMENT_MAX_SCANNED_PAGES, DOCUMENT_MAX_SECTIONS, DOCUMENT_MAX_TEXT, DOCUMENT_MIME, documentFormat, inspectDocument } from './documentAttachment.ts'
import type { ChatDocumentAttachment, DocumentFormat, DocumentSection, ParsedDocument } from './documentAttachment.ts'

type Progress = (title: string) => void
const PDF_CMAPS = import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', { eager: true, query: '?url&no-inline', import: 'default' }) as Record<string, string>
const PDF_FONTS = import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { eager: true, query: '?url&no-inline', import: 'default' }) as Record<string, string>
const PDF_WASM = import.meta.glob('/node_modules/pdfjs-dist/wasm/*.{wasm,js}', { eager: true, query: '?url&no-inline', import: 'default' }) as Record<string, string>
export const PDF_MAX_IMAGE_PIXELS = 40_000_000
const assets = (paths: Record<string, string>) => Object.fromEntries(Object.entries(paths).map(([name, url]) => [name.split('/').at(-1)!, url]))
const binaryAssets: Record<string, Record<string, string>> = { cMapUrl: assets(PDF_CMAPS), standardFontDataUrl: assets(PDF_FONTS), wasmUrl: assets(PDF_WASM) }

/** PDF.js 6 uses one factory for packed CMaps, standard fonts and image decoders. */
export class LocalPdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }) {
    const url = binaryAssets[kind]?.[filename]
    if (!url) throw new Error(`PDF 内置资源不可用：${filename}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`PDF 内置资源读取失败：${filename}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

/** Both the page and PDF.js's temporary image canvases stay in this worker. */
export class WorkerCanvasFactory {
  create(width: number, height: number) {
    const canvas = new OffscreenCanvas(Math.ceil(width), Math.ceil(height))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境不能读取 PDF 图像页')
    return { canvas, context }
  }
  reset(target: { canvas: OffscreenCanvas }, width: number, height: number) { target.canvas.width = Math.ceil(width); target.canvas.height = Math.ceil(height) }
  destroy(target: { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }) {
    if (target.canvas) target.canvas.width = target.canvas.height = 0
    target.canvas = null; target.context = null
  }
}

// OffscreenCanvas cannot reference SVG filters in a DOM. Fail explicitly for
// those uncommon PDF transfer/soft-mask operations instead of omitting pixels.
class WorkerFilterFactory {
  addFilter(maps: unknown) { if (!maps) return 'none'; throw new Error('此 PDF 图像使用暂不支持的颜色转换，请将相关页面另存为图片上传') }
  addHCMFilter() { return 'none' }
  addAlphaFilter(map: unknown) { if (!map) return 'none'; throw new Error('此 PDF 图像使用暂不支持的透明蒙版，请将相关页面另存为图片上传') }
  addLuminosityFilter() { throw new Error('此 PDF 图像使用暂不支持的亮度蒙版，请将相关页面另存为图片上传') }
  addKnockoutFilter() { throw new Error('此 PDF 图像使用暂不支持的镂空混合，请将相关页面另存为图片上传') }
  destroy() { /* No DOM resources. */ }
}

function dataURL(bytes: Uint8Array, mime: string) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return `data:${mime};base64,${btoa(binary)}`
}

function checkText(sections: DocumentSection[]) {
  if (!sections.length) throw new Error('文档中没有可读取的内容')
  if (sections.length > DOCUMENT_MAX_SECTIONS || sections.reduce((sum, section) => sum + section.text.length, 0) > DOCUMENT_MAX_TEXT) throw new Error('文档内容过多，请按章节或工作表拆分后上传；未截断或发送原文')
}

/** Inspect central-directory sizes before allocating decompressed XML/media. */
export function inspectOfficeArchive(bytes: Uint8Array, format: 'docx' | 'xlsx') {
  const names = new Set<string>()
  let total = 0, entries = 0
  unzipSync(bytes, { filter: entry => {
    total += entry.originalSize; entries++
    if (total > 64 * 1024 * 1024 || entry.originalSize > 24 * 1024 * 1024 || entries > 5000) throw new Error('Office 文档展开后过大，请拆分后上传')
    names.add(entry.name)
    return false
  } })
  if (!names.has(format === 'docx' ? 'word/document.xml' : 'xl/workbook.xml')) throw new Error('文档内容与扩展名不一致')
}

type HtmlNode = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: HtmlNode[] }
const nodeText = (node: HtmlNode): string => node.type === 'text' ? node.data ?? '' : node.name === 'br' ? '\n' : (node.children ?? []).map(nodeText).join('') + (['p', 'li'].includes(node.name ?? '') ? '\n' : '')

/** HTML is parsed as data only; no document markup is inserted into the UI. */
export function wordHtmlSections(html: string): DocumentSection[] {
  const sections: DocumentSection[] = []
  let paragraph = 0, table = 0
  const visit = (node: HtmlNode) => {
    if (node.name === 'table') {
      const tableId = ++table
      let row = 0
      const occupied = new Map<number, number>()
      const rows = (parent: HtmlNode) => {
        for (const child of parent.children ?? []) {
          if (child.name === 'tr') {
            row++; let column = 1
            const cells: string[] = []
            for (const cell of child.children ?? []) if (cell.name === 'td' || cell.name === 'th') {
              while ((occupied.get(column) ?? 0) >= row) column++
              const span = Math.max(1, Number(cell.attribs?.colspan) || 1), down = Math.max(1, Number(cell.attribs?.rowspan) || 1)
              cells.push(`R${row}C${column}${span > 1 || down > 1 ? ` [跨${down}行×${span}列]` : ''}: ${nodeText(cell).trim()}`)
              for (let col = column; col < column + span; col++) occupied.set(col, row + down - 1)
              column += span
            }
            sections.push({ label: `表 ${tableId} · 第 ${row} 行`, text: cells.join('\n') })
          } else if (child.name !== 'table') rows(child)
        }
      }
      rows(node)
      return
    }
    if (['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(node.name ?? '')) {
      const text = nodeText(node).trim()
      if (text) sections.push({ label: `正文段 ${++paragraph}`, text })
      return
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(parseDocument(html))
  checkText(sections)
  return sections
}

async function readWord(bytes: Uint8Array, progress: Progress): Promise<ParsedDocument> {
  inspectOfficeArchive(bytes, 'docx')
  progress('正在读取 Word 正文与表格')
  // The prebuilt browser entry cannot pull in the CLI's argparse/fs path.
  // @ts-expect-error Mammoth publishes types for its library, not its browser bundle.
  const { default: browserMammoth } = await import('mammoth/mammoth.browser.js')
  const mammoth: typeof import('mammoth') = browserMammoth
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer as ArrayBuffer }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
  })
  if (result.messages.some(message => message.type === 'error')) throw new Error('Word 部分内容无法解析，请另存为 PDF 后上传；未发送不完整正文')
  const sections = wordHtmlSections(result.value)
  return { format: 'docx', sections, warnings: [
    '已提取正文与表格；Word 不保留固定页码，使用段号与表格行列定位。图片、批注、修订和公式排版未作为已读内容，请需要时另存为 PDF',
    ...result.messages.map(message => message.message),
  ] }
}

async function readSheets(bytes: Uint8Array, format: DocumentFormat, progress: Progress): Promise<ParsedDocument> {
  if (format === 'xlsx') inspectOfficeArchive(bytes, 'xlsx')
  progress('正在读取工作表与行列')
  const XLSX = await import('xlsx')
  // UTF-8/UTF-16 CSV/TSV is decoded explicitly: binary autodetection treats
  // BOM-less UTF-8 as a legacy code page and can silently corrupt Chinese text.
  let input: Uint8Array | string = bytes
  if (format === 'csv' || format === 'tsv') {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    try { input = new TextDecoder(encoding, { fatal: true }).decode(bytes) }
    catch { throw new Error('CSV／TSV 文本编码无法识别，请另存为 UTF-8 后上传；未猜测字符') }
  }
  const workbook = XLSX.read(input, { type: typeof input === 'string' ? 'string' : 'array', raw: format === 'csv' || format === 'tsv', ...(format === 'tsv' ? { FS: '\t' } : {}), cellDates: false, cellFormula: true, cellNF: true, cellHTML: false, sheetStubs: true, bookVBA: false })
  const sections: DocumentSection[] = [], warnings = new Set<string>()
  let chars = 0, cells = 0
  if (workbook.SheetNames.length > 100) throw new Error('工作表过多，请选择需要的工作表后另存上传')
  for (const name of workbook.SheetNames) {
    progress(`正在读取工作表 · ${name}`)
    const sheet = workbook.Sheets[name]
    if (!sheet['!ref']) { sections.push({ label: name, text: '空工作表' }); continue }
    const range = XLSX.utils.decode_range(sheet['!ref'])
    if (range.e.r - range.s.r >= 50000 || range.e.c - range.s.c >= 500 || (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1) > 2_000_000) throw new Error(`「${name}」行列范围过大，请另存需要的区域后上传`)
    let chunk: string[] = [], from = range.s.r + 1, chunkChars = 0
    const flush = (to: number) => { if (chunk.length) sections.push({ label: `${name} · 第${from}–${to}行`, text: chunk.join('\n') }); chunk = []; chunkChars = 0; from = to + 1 }
    for (let row = range.s.r; row <= range.e.r; row++) {
      const values: string[] = []
      for (let col = range.s.c; col <= range.e.c; col++) {
        const address = XLSX.utils.encode_cell({ r: row, c: col }), cell = sheet[address]
        if (!cell || (cell.t === 'z' && !cell.f)) continue
        if (++cells > 250000) throw new Error('表格单元格过多，请分工作表或区域上传')
        const value = cell.v === undefined ? '' : XLSX.utils.format_cell(cell)
        const formula = cell.f ? ` [公式 =${cell.f}；${cell.v === undefined ? '没有缓存结果，未计算' : `缓存结果：${value}，未重新计算`}${cell.F ? `；数组范围 ${cell.F}` : ''}]` : ''
        if (cell.f) warnings.add('公式保留原式与文件中的缓存结果；本机未执行公式，缓存可能过时')
        if (value || formula) values.push(`${address}: ${value}${formula}`)
      }
      if (values.length) { const line = values.join(' | '); chars += line.length; chunkChars += line.length; chunk.push(line) }
      if (chars > DOCUMENT_MAX_TEXT) throw new Error('表格文字过多，请分工作表或区域上传；未截断内容')
      if (row % 40 === 39 || chunkChars >= 6000) flush(row + 1)
    }
    flush(range.e.r + 1)
    const merges = (sheet['!merges'] ?? []).map(item => XLSX.utils.encode_range(item))
    if (merges.length) sections.push({ label: `${name} · 合并单元格`, text: merges.join('、') })
    if (workbook.Workbook?.Sheets?.find(item => item.name === name)?.Hidden) warnings.add('包含隐藏工作表，已保留其名称与内容')
    if ((sheet['!rows'] ?? []).some(row => row?.hidden) || (sheet['!cols'] ?? []).some(col => col?.hidden)) warnings.add('包含隐藏行列，已保留对应单元格')
  }
  warnings.add('仅提取单元格、公式缓存与合并范围；图表、图片、批注和宏未作为已读内容')
  checkText(sections)
  return { format, sections, warnings: [...warnings] }
}

async function readPdf(bytes: Uint8Array, progress: Progress): Promise<ParsedDocument> {
  progress('正在打开 PDF')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // PDF.js's in-process transport runs inside our dedicated parsing worker.
  // @ts-expect-error PDF.js ships declarations for the display API only.
  const handler = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  ;(globalThis as typeof globalThis & { pdfjsWorker?: unknown }).pdfjsWorker = handler
  // Decode into transferable pixel buffers inside the parser; OffscreenCanvas
  // below still performs actual page rendering and JPEG encoding in our worker.
  const loading = pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, isOffscreenCanvasSupported: false,
    BinaryDataFactory: LocalPdfBinaryDataFactory, CanvasFactory: WorkerCanvasFactory, FilterFactory: WorkerFilterFactory,
    // Fonts render as PDF paths, avoiding DOM font/style injection in a worker.
    disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, stopAtErrors: true, maxImageSize: PDF_MAX_IMAGE_PIXELS })
  try {
    const pdf = await loading.promise
    if (pdf.numPages > 300) throw new Error('PDF 超过 300 页，请按章节拆分后上传')
    // PDF.js 6.4's display API can resolve getOperatorList with a partial list
    // before rejecting it on a stream error. Latch the original transport error
    // before it reaches that handler, so an oversized image cannot disappear
    // from an otherwise readable text page. This is local to this document.
    type StreamSender = (action: string, ...args: unknown[]) => ReadableStream<unknown>
    const transport = (pdf as unknown as { _transport: { messageHandler: { sendWithStream: StreamSender } } })._transport.messageHandler
    const sendWithStream = transport.sendWithStream.bind(transport)
    let operatorError: unknown
    transport.sendWithStream = (action, ...args) => {
      const stream = sendWithStream(action, ...args)
      if (action !== 'GetOperatorList') return stream
      const reader = stream.getReader()
      return new ReadableStream({
        async pull(controller) {
          try {
            const { value, done } = await reader.read()
            if (done) controller.close(); else controller.enqueue(value)
          } catch (error) { operatorError = error; controller.error(error) }
        },
        cancel(reason) { return reader.cancel(reason) },
      })
    }
    const sections: DocumentSection[] = [], warnings = new Set<string>()
    let chars = 0, imageBytes = 0, scanned = 0
    for (let index = 1; index <= pdf.numPages; index++) {
      progress(`正在读取 PDF · ${index}/${pdf.numPages} 页`)
      const page = await pdf.getPage(index)
      try {
        const content = await page.getTextContent()
        let text = ''
        for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ')
        text = text.replace(/[ \t]+\n/gu, '\n').trim(); chars += text.length
        if (chars > DOCUMENT_MAX_TEXT) throw new Error('PDF 正文过长，请按章节拆分后上传；未截断原文')
        const section: DocumentSection = { label: `第 ${index} 页`, text }
        const ops = await page.getOperatorList()
        if (operatorError) throw operatorError
        const imageOps: number[] = [pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintInlineImageXObjectGroup, pdfjs.OPS.paintImageMaskXObjectGroup]
        const hasImages = ops.fnArray.some(op => imageOps.includes(op))
        if (text.replace(/\s/gu, '').length < 12 || hasImages) {
          if (++scanned > DOCUMENT_MAX_SCANNED_PAGES) throw new Error('PDF 图像页超过 40 页，请分段上传以保留可辨认的清晰度')
          if (typeof OffscreenCanvas === 'undefined') throw new Error('当前环境暂不能读取 PDF 图像页，请将需要的页面截成图片上传')
          progress(`正在读取图像页 · ${index}/${pdf.numPages} 页`)
          const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(base.width, base.height)) })
          const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
          try {
            await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise
            if (operatorError) throw operatorError
            for (let op = 0; op < ops.fnArray.length; op++) if (imageOps.includes(ops.fnArray[op])) {
              const id = ops.argsArray[op]?.[0]
              if (typeof id === 'string') {
                const objects = id.startsWith('g_') ? page.commonObjs : page.objs
                if (!objects.has(id) || !objects.get(id)) throw new Error('PDF 内的图片未能完整解码，请将相关页面另存为图片上传；未发送空白替代页')
              }
            }
            const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: .9 }), image = new Uint8Array(await blob.arrayBuffer())
            if (blob.type !== 'image/jpeg' || image[0] !== 0xff || image[1] !== 0xd8) throw new Error('PDF 页面图像未能生成 JPEG，请重新选择文件')
            imageBytes += image.byteLength
            if (imageBytes > DOCUMENT_MAX_IMAGE_BYTES) throw new Error('PDF 页图像合计过大，请按章节拆分后上传')
            section.image = { mime: 'image/jpeg', size: image.byteLength, data: dataURL(image, 'image/jpeg') }
            warnings.add('图像页保留原页 JPEG（最长边至多 1800px）；未执行 OCR，需模型读取，不清晰内容必须说明')
          } finally { canvas.width = canvas.height = 1 }
        }
        sections.push(section)
      } finally { page.cleanup() }
    }
    warnings.add('PDF 以原页定位；文字按文件阅读顺序提取，复杂分栏、矢量图与公式排版需对照原文件，未推测未提取内容')
    checkText(sections)
    return { format: 'pdf', sections, warnings: [...warnings] }
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('PDF 已加密，请先解锁后上传')
    if (error instanceof Error && error.message.includes('Image exceeded maximum allowed size')) throw new Error('PDF 内单张图片超过 4000 万像素，请降低扫描分辨率或拆分原图后上传；未发送空白替代页')
    throw error
  } finally { await loading.destroy() }
}

/** Production callers invoke this only from documentReader.worker.ts. */
export async function readDocument(file: File, progress: Progress = () => {}): Promise<ChatDocumentAttachment> {
  assertDocumentSize(file.size)
  const format = documentFormat(file.name)
  if (!format) throw new Error(file.name.toLowerCase().endsWith('.doc') ? '旧版 .doc 请另存为 .docx 或 PDF 后上传' : '支持 PDF、Word（.docx）和 Excel／CSV／TSV 表格')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength !== file.size) throw new Error('文档附件大小不一致，请重新选择')
  inspectDocument(bytes, format)
  const document = format === 'pdf' ? await readPdf(bytes, progress) : format === 'docx' ? await readWord(bytes, progress) : await readSheets(bytes, format, progress)
  return { kind: 'document', name: file.name.slice(0, 160), mime: DOCUMENT_MIME[format], size: bytes.byteLength, data: dataURL(bytes, DOCUMENT_MIME[format]), document }
}
