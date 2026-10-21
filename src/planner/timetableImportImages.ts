import type { ChatAttachment } from '../xixi/types'
import { readChatImage } from '../xixi/chatAttachments.ts'
import { assertChatImageDimensions, inspectChatImage } from '../xixi/chatImagePolicy.ts'

export const TIMETABLE_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export type TimetableImportRow = {
  id: string; weekday: number | null; period: string; subject: string; subjectGroup?: string
  location: string; classGroup?: string; start: string; end: string
  weekCycle: 'weekly' | 'odd' | 'even'; note: string; uncertain?: boolean; cell?: string
}
export type TimetableDraft = { kind: 'combined' | 'personal' | 'uncertain'; rows: TimetableImportRow[] }
export type TimetableGroupQuestion = { id: string; subjects: string[]; family: string; options: string[] }

/** Ambiguous OCR is quarantined, never "fixed" by stripping a name prefix.
 * No school-specific names or codes; a conservative false positive is editable.
 */
export function quarantineTimetableCode(row: TimetableImportRow): TimetableImportRow {
  const mixed = /((?:[A-Za-z][A-Za-z.'’\-]*\s+){2,})[A-Za-z][A-Za-z&/\-]*\d+[A-Za-z0-9]*(?=$|[\s,;·()])/u
  const prefixes = [row.subject, row.subjectGroup ?? ''].map(value => value.match(mixed)?.[1].trim()).filter((value): value is string => Boolean(value))
  if (!prefixes.length) return row
  const safe = (value: string | undefined) => value && prefixes.some(prefix => value.includes(prefix)) ? '' : value
  return { ...row, subject: '', subjectGroup: '', uncertain: true, note: '未能分清课程代码与其它文字，请对照该格补齐',
    location: safe(row.location) ?? '', classGroup: safe(row.classGroup), cell: safe(row.cell) }
}

// These are display families for explicit labels, never inferred membership.
// Scope each question to the exact code; the answer applies to all its days.
function groupFamily(label: string) {
  const value = label.trim()
  if (/^分组\s*\d+$/u.test(value)) return '分组'
  if (/^G\s*\d+$/u.test(value)) return 'G 分组'
  if (/^[A-Z]$/u.test(value)) return '字母分组'
  if (/^(?:男生|女生)$/u.test(value)) return '男生 / 女生'
  const prefix = value.match(/^(.+?)[\d一二三四五六七八九十]+$/u)?.[1]
  return prefix ? `${prefix}分组` : '原图分组'
}

export function timetableCodeGroups(rows: TimetableImportRow[]) {
  const seen = new Set<string>(), groups = new Map<string, string[]>()
  for (const row of rows) {
    if (!row.subject.trim() || seen.has(row.subject)) continue
    seen.add(row.subject)
    const group = row.subjectGroup || '未分科'
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(row.subject)
  }
  return [...groups].map(([subjectGroup, codes]) => ({ subjectGroup, codes }))
}

function sameTimetableCell(a: TimetableImportRow, b: TimetableImportRow) {
  if (a.weekCycle !== 'weekly' && b.weekCycle !== 'weekly' && a.weekCycle !== b.weekCycle) return false
  if (!a.weekday || a.weekday !== b.weekday) return Boolean(a.cell && a.cell === b.cell)
  return Boolean(a.period && a.period === b.period) || Boolean(a.start && a.end && a.start === b.start && a.end === b.end)
}

export function timetableGroupQuestions(rows: TimetableImportRow[], codes: ReadonlySet<string>): TimetableGroupQuestion[] {
  const questions = new Map<string, TimetableGroupQuestion>()
  const languageCodes = ['Eng', 'L&L', 'Lit']
  const selectedLanguage = languageCodes.some(code => codes.has(code))
  for (const row of rows) {
    if (!row.classGroup?.trim()) continue
    const family = groupFamily(row.classGroup)
    // Explicit numbered groups are reused across the language subjects. A/B,
    // E/F etc only disambiguate duplicate candidates of the SAME code/slot.
    const shared = family === '分组' && languageCodes.includes(row.subject)
    if (!codes.has(row.subject) && !(shared && selectedLanguage)) continue
    const duplicates = rows.filter(other => other.subject === row.subject && sameTimetableCell(row, other))
    if (!shared && !duplicates.some(other => other.classGroup?.trim() && other.classGroup !== row.classGroup && groupFamily(other.classGroup) === family)) continue
    const id = JSON.stringify([shared ? 'Eng/L&L/Lit' : row.subject, family])
    if (!questions.has(id)) questions.set(id, { id, subjects: [], family, options: [] })
    const question = questions.get(id)!
    if (!question.subjects.includes(row.subject)) question.subjects.push(row.subject)
    if (!question.options.includes(row.classGroup)) question.options.push(row.classGroup)
  }
  return [...questions.values()].filter(question => question.options.length > 1)
}

export function matchTimetableRows(rows: TimetableImportRow[], codes: ReadonlySet<string>, answers: Readonly<Record<string, string>>): TimetableImportRow[] {
  const questions = timetableGroupQuestions(rows, codes)
  return rows.filter(row => {
    if (!row.subject.trim() || !codes.has(row.subject)) return false
    if (!row.classGroup?.trim()) return true
    const question = questions.find(item => item.subjects.includes(row.subject) && item.family === groupFamily(row.classGroup!))
    return !question || answers[question.id] === row.classGroup
  })
}

export function timetableAmbiguousIds(rows: TimetableImportRow[]): Set<string> {
  return new Set(rows.filter(row => rows.some(other => other.id !== row.id && other.subject === row.subject && sameTimetableCell(row, other)
    && (other.classGroup ?? '') === (row.classGroup ?? '') && other.location !== row.location)).map(row => row.id))
}

export function timetableNeedsReview(row: TimetableImportRow) {
  return Boolean(row.uncertain || !row.subject.trim() || !row.weekday || !row.period.trim() || !row.start || !row.end)
}

export function applyTimetablePeriodTimes(rows: TimetableImportRow[], period: string, start: string, end: string): TimetableImportRow[] {
  if (!period.trim() || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(start) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(end) || start >= end) throw new Error('请按原图输入明确的24小时节次时刻')
  return rows.map(row => row.period === period ? { ...row, start, end } : row)
}

/** Only the absence of alternatives in readable slots is classified here.
 * The UI offers an explicit bulk action; it never silently chooses these. */
export function timetableCommonCodes(rows: TimetableImportRow[]): string[] {
  const codes = [...new Set(rows.filter(row => row.subject.trim()).map(row => row.subject))]
  return codes.filter(code => rows.filter(row => row.subject === code).every(row => {
    if (timetableNeedsReview(row) || row.classGroup?.trim()) return false
    return !rows.some(other => other.subject !== code && other.weekday === row.weekday &&
      (row.start && row.end && other.start && other.end ? row.start < other.end && other.start < row.end : row.period === other.period))
  }))
}
export type CropOptions = { headerWidth: number; headerHeight: number }
export type CropPiece = { sx: number; sy: number; width: number; height: number; dx: number; dy: number }
export type TimetableCrop = { width: number; height: number; pieces: CropPiece[] }
type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void }
type ImageRuntime = {
  decode: (blob: Blob) => Promise<Decoded>
  render: (image: CanvasImageSource, crop: TimetableCrop) => Promise<Blob>
  read: typeof readChatImage
}

/** 2×3 tiles, with the original top/left headers repeated at native pixels.
 * Small overlap avoids losing text sitting on an automatically chosen seam.
 * No source-to-destination scaling is permitted by the piece contract.
 */
export function planTimetableCrops(width: number, height: number, { headerWidth, headerHeight }: CropOptions): TimetableCrop[] {
  assertChatImageDimensions({ width, height })
  if (!Number.isInteger(headerWidth) || !Number.isInteger(headerHeight) || headerWidth < 0 || headerHeight < 0 || headerWidth >= width || headerHeight >= height) throw new Error('表头范围需在原图内，并保留课程内容')
  const columns = Math.min(2, width - headerWidth), rows = Math.min(3, height - headerHeight)
  const crops: TimetableCrop[] = []
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const left = Math.max(headerWidth, headerWidth + Math.floor((width - headerWidth) * col / columns) - 24)
    const right = Math.min(width, headerWidth + Math.ceil((width - headerWidth) * (col + 1) / columns) + 24)
    const top = Math.max(headerHeight, headerHeight + Math.floor((height - headerHeight) * row / rows) - 24)
    const bottom = Math.min(height, headerHeight + Math.ceil((height - headerHeight) * (row + 1) / rows) + 24)
    const w = right - left, h = bottom - top
    const pieces: CropPiece[] = []
    if (headerWidth && headerHeight) pieces.push({ sx: 0, sy: 0, width: headerWidth, height: headerHeight, dx: 0, dy: 0 })
    if (headerHeight) pieces.push({ sx: left, sy: 0, width: w, height: headerHeight, dx: headerWidth, dy: 0 })
    if (headerWidth) pieces.push({ sx: 0, sy: top, width: headerWidth, height: h, dx: 0, dy: headerHeight })
    pieces.push({ sx: left, sy: top, width: w, height: h, dx: headerWidth, dy: headerHeight })
    crops.push({ width: headerWidth + w, height: headerHeight + h, pieces })
  }
  return crops
}

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
  }
  const image = new Image(), url = URL.createObjectURL(blob)
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片无法解码'))
      image.src = url
    })
    if (image.decode) await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ''; URL.revokeObjectURL(url) } }
  } catch { URL.revokeObjectURL(url); throw new Error('图片无法解码，请重新选择') }
  finally { image.onload = image.onerror = null }
}

async function render(source: CanvasImageSource, crop: TimetableCrop): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = crop.width; canvas.height = crop.height
  try {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('当前环境无法裁图，请关闭精细识别后重试')
    context.imageSmoothingEnabled = false
    for (const p of crop.pieces) context.drawImage(source, p.sx, p.sy, p.width, p.height, p.dx, p.dy, p.width, p.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('裁片生成失败，请关闭精细识别后重试')), 'image/png'))
  } finally { canvas.width = canvas.height = 0 }
}

/** Local only; the original is always first and byte-for-byte unchanged.
 * All crops are prepared before the single recognition request is sent.
 * Injectable pixel operations let tests exercise coverage/budgets offline.
 */
export async function prepareTimetableImages(original: ChatAttachment, options: CropOptions & { split: boolean; signal?: AbortSignal }, runtime: ImageRuntime = { decode, render, read: readChatImage }): Promise<ChatAttachment[]> {
  const cancel = () => { if (options.signal?.aborted) throw new DOMException('已取消图片整理', 'AbortError') }
  cancel()
  const prefix = `data:${original.mime};base64,`
  if (!original.data.startsWith(prefix) || original.data.length > prefix.length + Math.ceil(10 * 1024 * 1024 / 3) * 4) throw new Error('原图附件无效或过大')
  const encoded = original.data.slice(prefix.length)
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error('原图附件无效')
  const binary = atob(encoded)
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0)), info = inspectChatImage(bytes)
  if (btoa(binary) !== encoded || bytes.length !== original.size || info.mime !== original.mime) throw new Error('原图附件内容不一致')
  if (!options.split) return [original]
  const decoded = await runtime.decode(new Blob([bytes], { type: info.mime }))
  try {
    cancel()
    const { width, height } = decoded
    if (!((width === info.width && height === info.height) || (width === info.height && height === info.width))) throw new Error('图片解码尺寸不一致')
    const crops = planTimetableCrops(width, height, options)
    const images = [original]
    let total = original.size
    for (let index = 0; index < crops.length; index++) {
      cancel()
      const blob = await runtime.render(decoded.source, crops[index])
      cancel()
      if (blob.type !== 'image/png') throw new Error('裁片必须使用 PNG 格式')
      total += blob.size
      if (total > TIMETABLE_MAX_IMAGE_BYTES) throw new Error('原图与裁片总量超过 20 MiB，请关闭精细识别或先在本地裁去无关区域')
      const attachment = await runtime.read(new File([blob], `课表裁片-${index + 1}.png`, { type: 'image/png' }))
      if (attachment.size !== blob.size || attachment.mime !== 'image/png') throw new Error('裁片内容不一致')
      images.push(attachment)
    }
    cancel()
    return images
  } finally { decoded.close() }
}
