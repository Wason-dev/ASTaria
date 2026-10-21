import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { ImportSurface, ImportStep, ImportCloseIcon, ImportBackIcon, ImportFileIcon, ImportSelect } from './ImportSurface'
import type { ImportSurfaceHandle, ImportSurfaceParentProps } from './ImportSurface'
import { localApi, LocalApiError } from '../xixi/api'
import { CHAT_IMAGE_ACCEPT, readChatImage } from '../xixi/chatAttachments'
import type { ChatAttachment } from '../xixi/types'
import type { PlannerState } from './types'
import { weekStart } from './weekCycle'
import { prepareTimetableImages, timetableCodeGroups, timetableGroupQuestions, matchTimetableRows, timetableNeedsReview, timetableCommonCodes, timetableAmbiguousIds, applyTimetablePeriodTimes, quarantineTimetableCode } from './timetableImportImages'
import type { TimetableDraft, TimetableImportRow } from './timetableImportImages'
import './timetable-import.css'

export type { TimetableImportRow } from './timetableImportImages'
export type TimetableImportReceipt = { id: string; summary: string; undoable: boolean; undoneAt: string | null }
type ImportResult = { state: PlannerState; importedCount: number; importedIds: string[]; operation: TimetableImportReceipt }
type Props = ImportSurfaceParentProps & { onClose: () => void; onSaved: (state: PlannerState, operation?: TimetableImportReceipt) => void }
type Status = { configured: boolean; model: string; supportsVision?: boolean }
type Phase = 'idle' | 'reading' | 'preparing' | 'recognizing' | 'saving' | 'undoing'
type Step = 'upload' | 'codes' | 'groups' | 'preview'
const DAYS = ['一', '二', '三', '四', '五', '六', '日']
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/u
const RANGE = /(?:\d+\s*(?:[-–—~～至到、,，]\s*\d+)+\s*周|第\s*\d+\s*周|前\s*\d+\s*周|仅.{0,12}周|weeks?\s*\d|\d+\s*[-–]\s*\d+\s*weeks?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/iu
const restricted = (row: TimetableImportRow) => RANGE.test(`${row.period} ${row.note}`.replace(/仅(?:在)?[单双]周/gu, ''))
const incomplete = (row: TimetableImportRow) => !row.subject.trim() || !row.period.trim() || !Number.isInteger(row.weekday) || !row.weekday || row.weekday < 1 || row.weekday > 7 || !CLOCK.test(row.start) || !CLOCK.test(row.end) || row.start >= row.end || restricted(row)
const clashes = (a: TimetableImportRow, b: TimetableImportRow) => a.weekday === b.weekday && (a.weekCycle === 'weekly' || b.weekCycle === 'weekly' || a.weekCycle === b.weekCycle) && a.start < b.end && b.start < a.end
const pending = (row: TimetableImportRow) => row.uncertain === true || incomplete(row)

function readDraft(value: unknown): TimetableDraft {
  const draft = (value as { draft?: TimetableDraft })?.draft
  if (!draft || !['combined', 'personal', 'uncertain'].includes(draft.kind) || !Array.isArray(draft.rows) || !draft.rows.length || draft.rows.length > 300) throw new Error('INVALID_DRAFT')
  const ids = new Set<string>()
  const lengths = { id: 80, period: 80, subject: 160, location: 160, start: 5, end: 5, note: 500, subjectGroup: 80, classGroup: 160, cell: 160 }
  const optional = ['subjectGroup', 'classGroup', 'cell']
  const rows = draft.rows.map(row => {
    if (!row || typeof row !== 'object' || !(row.weekday === null || Number.isInteger(row.weekday) && row.weekday >= 0 && row.weekday <= 7)
      || !['weekly', 'odd', 'even'].includes(row.weekCycle) || row.uncertain !== undefined && typeof row.uncertain !== 'boolean'
      || Object.entries(lengths).some(([key, max]) => {
        const value = row[key as keyof typeof lengths]
        return value === undefined && optional.includes(key) ? false : typeof value !== 'string' || value.length > max
      }) || !row.id.trim() || ids.has(row.id) || 'teacher' in row && row.teacher !== '') throw new Error('INVALID_ROW')
    ids.add(row.id)
    return quarantineTimetableCode({ id: row.id, weekday: row.weekday, period: row.period, subject: row.subject, subjectGroup: row.subjectGroup ?? '', location: row.location,
      classGroup: row.classGroup ?? '', start: row.start, end: row.end, weekCycle: row.weekCycle, note: row.note, uncertain: row.uncertain ?? false, cell: row.cell ?? '' })
  })
  return { kind: draft.kind, rows }
}
function isReceipt(value: unknown): value is TimetableImportReceipt {
  const receipt = value as TimetableImportReceipt
  return Boolean(receipt && typeof receipt.id === 'string' && receipt.id.length <= 200 && receipt.id && typeof receipt.summary === 'string' && receipt.summary.length <= 240 && typeof receipt.undoable === 'boolean' && (receipt.undoneAt === null || typeof receipt.undoneAt === 'string'))
}

function PreviewRow({ row, disabled, ambiguous, onEdit, onRemove, onInclude }: { row: TimetableImportRow; disabled: boolean; ambiguous: boolean; onEdit: (patch: Partial<TimetableImportRow>) => void; onRemove: () => void; onInclude?: () => void }) {
  const needsFix = incomplete(row) || row.uncertain
  return <fieldset className="tti-row" disabled={disabled} data-testid="timetable-preview-row" data-uncertain={Boolean(needsFix || ambiguous)}>
    <legend className="tti-sr">{row.subject || '待补格子'}</legend>
    <div className="tti-row-title"><strong>{row.subject || '代码待补'} · {row.weekday ? `周${DAYS[row.weekday - 1]}` : '星期待补'} · {row.period ? `第 ${row.period} 节` : '节次待补'} · {row.location || '教室未识别，可留空'}</strong><button type="button" onClick={onRemove}>移除</button></div>
    <p className="tti-muted">{row.start || '开始待补'}–{row.end || '结束待补'}{row.classGroup ? ` · ${row.classGroup}` : ''} · {row.weekCycle === 'odd' ? '单周' : row.weekCycle === 'even' ? '双周' : '每周'}</p>
    {row.cell && <p className="tti-cell">原图位置：{row.cell}</p>}
    {row.note && <p className="tti-warning">{row.note}</p>}
    {ambiguous && <p className="tti-warning">同代码同一格有不同教室且无法按组区分，请对照原图保留正确项，不能自动取第一项。</p>}
    <details open={needsFix || undefined}><summary>编辑这项课程</summary>
      <div className="tti-row-main"><ImportSelect label="星期" value={String(row.weekday ?? 0)} options={[{ value: "0", label: "待补" }, ...DAYS.map((name, index) => ({ value: String(index + 1), label: `周${name}` }))]} onChange={value => onEdit({ weekday: Number(value) })} /><label>节次<input maxLength={80} value={row.period} onChange={event => onEdit({ period: event.target.value })} /></label><label className="tti-subject">原始代码<input maxLength={160} value={row.subject} onChange={event => onEdit({ subject: event.target.value })} /></label><label>分组原文<input maxLength={160} value={row.classGroup ?? ''} onChange={event => onEdit({ classGroup: event.target.value })} /></label></div>
      <div className="tti-row-times"><label>教室（可留空）<input maxLength={160} value={row.location} onChange={event => onEdit({ location: event.target.value })} /></label><label>开始<input type="time" value={row.start} onChange={event => onEdit({ start: event.target.value })} /></label><label>结束<input type="time" value={row.end} onChange={event => onEdit({ end: event.target.value })} /></label><ImportSelect label="周期" value={row.weekCycle} options={[{ value: "weekly", label: "每周" }, { value: "odd", label: "单周" }, { value: "even", label: "双周" }]} onChange={value => onEdit({ weekCycle: value as TimetableImportRow['weekCycle'] })} /></div>
      <label>备注 / 待补说明<input maxLength={500} value={row.note} onChange={event => onEdit({ note: event.target.value })} /></label>
    </details>
    {row.uncertain && <button type="button" disabled={incomplete(row) || !row.period.trim()} onClick={() => onEdit({ uncertain: false })}>已按原图补齐并核对这个格子</button>}
    {onInclude && <button type="button" disabled={pending(row) || !row.period.trim() || ambiguous} onClick={onInclude}>加入本次预览</button>}
    {incomplete(row) && <p className="tti-warning">代码、星期或钟点尚未补齐，或包含不支持的周范围，不能保存。</p>}
  </fieldset>
}

/** Parent mounts deliberately. Images and the draft never enter persistence. */
export function TimetableImport({ onClose, onSaved, onOpenChange }: Props) {
  const surface = useRef<ImportSurfaceHandle>(null), fileInput = useRef<HTMLInputElement>(null)
  const active = useRef(true), lock = useRef(false), writing = useRef(false), controller = useRef<AbortController | null>(null)
  const titleId = useId(), hintId = useId()
  const [phase, setPhase] = useState<Phase>('idle'), [error, setError] = useState('')
  const [recognitionStage, setRecognitionStage] = useState<'prepare' | 'send' | 'check' | ''>('')
  const [planner, setPlanner] = useState<PlannerState | null>(null), [status, setStatus] = useState<Status | null>(null)
  const [loading, setLoading] = useState(true), [stale, setStale] = useState(false)
  const [original, setOriginal] = useState<ChatAttachment | null>(null), [images, setImages] = useState<ChatAttachment[]>([])
  const [split, setSplit] = useState(false), [headers, setHeaders] = useState({ headerWidth: 0, headerHeight: 0 })
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 }), [zoom, setZoom] = useState(false), [dragging, setDragging] = useState(false)
  const [rows, setRows] = useState<TimetableImportRow[]>([]), [kind, setKind] = useState<TimetableDraft['kind']>('uncertain')
  const [step, setStep] = useState<Step>('upload'), [codes, setCodes] = useState<Set<string>>(new Set()), [answers, setAnswers] = useState<Record<string, string>>({})
  const [previewIds, setPreviewIds] = useState<Set<string>>(new Set()), [reviewIds, setReviewIds] = useState<Set<string>>(new Set()), [anchor, setAnchor] = useState('')
  const [saved, setSaved] = useState<ImportResult | null>(null), [receipt, setReceipt] = useState<TimetableImportReceipt | null>(null)
  const [undoVerified, setUndoVerified] = useState(false)
  const [periodTimes, setPeriodTimes] = useState<Record<string, { start: string; end: string }>>({})
  const sourceRows = useRef<TimetableImportRow[]>([])
  const manualIds = useRef(new Set<string>())
  const [manual, setManual] = useState(false)
  const busy = phase !== 'idle', frozen = busy || saved !== null, connected = status?.configured === true && status.supportsVision !== false
  // Matching uses the recognized identity, while review edits stay on each row.
  // Returning through code/group selection must not silently discard edited rows.
  const selectionRows = useMemo(() => { const source = new Map(sourceRows.current.map(row => [row.id, row])); return rows.map(row => source.get(row.id) ?? row) }, [rows])
  const codeGroups = useMemo(() => timetableCodeGroups(selectionRows), [selectionRows])
  const commonCodes = useMemo(() => timetableCommonCodes(selectionRows), [selectionRows])
  const questions = useMemo(() => timetableGroupQuestions(selectionRows, codes), [selectionRows, codes])
  const answered = questions.every(question => question.options.includes(answers[question.id]))
  const preview = useMemo(() => rows.filter(row => previewIds.has(row.id)), [rows, previewIds])
  const unresolved = useMemo(() => rows.filter(row => !previewIds.has(row.id) && (reviewIds.has(row.id) || timetableNeedsReview(row))), [rows, previewIds, reviewIds])
  const blockingUnresolved = unresolved.filter(row => !row.subject.trim() || codes.has(row.subject))
  const ambiguousIds = useMemo(() => timetableAmbiguousIds([...preview, ...unresolved]), [preview, unresolved])
  const conflicting = preview.some((row, index) => preview.slice(index + 1).some(other => clashes(row, other)))
  const needsAnchor = preview.some(row => row.weekCycle !== 'weekly')
  const badAnchor = Boolean(anchor && weekStart(anchor) !== anchor) || needsAnchor && !anchor
  const anchorMismatch = Boolean(anchor && planner?.firstWeekMonday && anchor !== planner.firstWeekMonday)
  const canSave = Boolean(step === 'preview' && planner && !loading && !stale && preview.length && !preview.some(pending) && !blockingUnresolved.length && !timetableAmbiguousIds(preview).size && !conflicting && !badAnchor && !anchorMismatch && !busy && !zoom && !saved)
  const codeWhitespace = rows.some(row => row.subject !== row.subject.trim() || row.classGroup !== undefined && row.classGroup !== row.classGroup.trim())
  const periods = [...new Set(rows.map(row => row.period).filter(period => period.trim()))]

  async function load(signal?: AbortSignal, initial = false) {
    setLoading(true)
    const results = await Promise.allSettled([localApi<PlannerState>('/planner', undefined, { signal }), localApi<Status>('/status', undefined, { signal })])
    if (!active.current || signal?.aborted) return
    const plan = results[0], model = results[1]
    if (plan.status === 'fulfilled' && Number.isSafeInteger(plan.value.revision)) {
      setPlanner(plan.value); setStale(false); setError('')
      if (initial) {
        const existing = [...new Set(plan.value.routines.filter(row => row.weekCycle === 'odd' || row.weekCycle === 'even').map(row => row.weekAnchor))]
        setAnchor(plan.value.firstWeekMonday ?? (existing.length === 1 ? existing[0] ?? '' : ''))
      }
    } else setError('日程版本读取失败，请重试；草稿和原图仍保留。')
    setStatus(model.status === 'fulfilled' ? model.value : null); setLoading(false)
  }
  useEffect(() => {
    active.current = true
    const abort = new AbortController()
    void load(abort.signal, true)
    return () => { active.current = false; abort.abort(); controller.current?.abort() }
  }, [])
  function close() { if (!writing.current) surface.current?.close() }
  function resetSelection() { setCodes(new Set()); setAnswers({}); setPreviewIds(new Set()); setStep('codes') }
  async function chooseFile(file: File) {
    if (lock.current || saved) return
    lock.current = true; setPhase('reading'); setError('')
    try { const attachment = await readChatImage(file); if (active.current) { setOriginal(attachment); setImages([]); setRows([]); setReviewIds(new Set()); resetSelection(); setZoom(false); setDimensions({ width: 0, height: 0 }); setStep('upload'); setManual(false); manualIds.current.clear(); sourceRows.current = [] } }
    catch { if (active.current) setError('图片读取失败，请使用有效的 PNG、JPEG 或 WebP，单图不超过 10 MiB。') }
    finally { lock.current = false; if (active.current) setPhase('idle') }
  }
  function dropped(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files') && !event.dataTransfer.files.length) return
    event.preventDefault(); event.stopPropagation(); setDragging(false)
    if (lock.current || saved || step !== 'upload') return
    if (event.dataTransfer.files.length !== 1) { setError('请一次提供一张原图，精细识别会本地生成裁片。'); return }
    void chooseFile(event.dataTransfer.files[0])
  }
  function picked(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseFile(file) }
  async function recognize() {
    if (!original || !connected || lock.current || saved) return
    lock.current = true; const abort = new AbortController(); controller.current = abort; setPhase('preparing'); setRecognitionStage('prepare'); setError('')
    try {
      const prepared = await prepareTimetableImages(original, { ...headers, split, signal: abort.signal })
      if (!active.current || abort.signal.aborted) return
      setImages(prepared); setPhase('recognizing'); setRecognitionStage('send')
      const raw = await localApi<unknown>('/planner/import/recognize', { images: prepared, split }, { signal: abort.signal, timeoutMs: 120_000 })
      if (!active.current || abort.signal.aborted) return
      setRecognitionStage('check')
      const result = readDraft(raw)
      manualIds.current.clear(); sourceRows.current = result.rows; setManual(false); setRows(result.rows); setKind(result.kind); setPeriodTimes({}); setReviewIds(new Set(result.rows.filter(timetableNeedsReview).map(row => row.id))); resetSelection()
    } catch (reason) { if (active.current) setError(abort.signal.aborted ? '识别已停止，原图与已有草稿仍保留。' : reason instanceof LocalApiError ? reason.message : '未能取得有效课表，请检查图片、表头范围和模型视觉支持，也可手动录入。') }
    finally { if (controller.current === abort) { controller.current = null; lock.current = false; if (active.current) { setPhase('idle'); setRecognitionStage('') } } }
  }
  function toggleCode(code: string) { setCodes(current => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next }) }
  function enterPreview() { setPreviewIds(new Set([...matchTimetableRows(selectionRows, codes, answers).map(row => row.id), ...rows.filter(row => manualIds.current.has(row.id)).map(row => row.id)])); setStep('preview'); setError('') }
  function continueCodes() { if (questions.length) setStep('groups'); else enterPreview() }
  function addRow() {
    const row: TimetableImportRow = { id: crypto.randomUUID(), weekday: null, period: '', subject: '', subjectGroup: '', location: '', classGroup: '', start: '', end: '', weekCycle: 'weekly', note: '', uncertain: true, cell: '手动补充格子' }
    if (!rows.length) setManual(true)
    manualIds.current.add(row.id)
    setRows(current => [...current, row]); setPreviewIds(current => new Set([...current, row.id])); setStep('preview')
  }
  function edit(id: string, patch: Partial<TimetableImportRow>) { setRows(current => current.map(row => row.id === id ? { ...row, ...patch } : row)) }
  function remove(id: string) { setRows(current => current.filter(row => row.id !== id)) }
  function applyPeriod(period: string) {
    const times = periodTimes[period]
    try { if (!times) throw new Error('missing'); setRows(applyTimetablePeriodTimes(rows, period, times.start, times.end)); setError('') }
    catch { setError('请按原图填写明确的24小时制开始和结束时刻，再应用到该节次全周。') }
  }
  async function notify(state: PlannerState, operation: TimetableImportReceipt) {
    try { await onSaved(state, operation) } catch { if (active.current) setError('日程已保存，但界面刷新未完成，请关闭后重新进入日程。') }
  }
  async function save() {
    if (!canSave || lock.current || !planner) return
    lock.current = true; writing.current = true; setPhase('saving'); setError('')
    try {
      const result = await localApi<ImportResult>('/planner/import/confirm', { rows: preview, expectedRevision: planner.revision, ...(anchor ? { firstWeekMonday: anchor } : {}) })
      if (!result || !isReceipt(result.operation) || result.operation.undoneAt || !result.operation.undoable || result.importedCount !== preview.length || !Array.isArray(result.importedIds) || result.importedIds.length !== preview.length || new Set(result.importedIds).size !== preview.length || !Number.isSafeInteger(result.state?.revision) || result.state.revision <= planner.revision || !Array.isArray(result.state.routines) || result.importedIds.some(id => !result.state.routines.some(row => row.id === id && row.kind === 'class'))) throw new Error('UNCONFIRMED_SAVE')
      if (active.current) { setPlanner(result.state); setSaved(result); setReceipt(result.operation) }
      await notify(result.state, result.operation)
    } catch (reason) {
      if (active.current) { setStale(true); setError(reason instanceof LocalApiError && reason.status < 500 ? '导入未通过核对，请检查重复、重叠、待补格子与第一周日期；重新读取日程后再确认。' : '保存结果尚未确认，请重新读取日程并核对是否已导入后再继续；草稿和原图仍保留。') }
    } finally { writing.current = false; lock.current = false; if (active.current) setPhase('idle') }
  }
  async function undo() {
    if (!saved || !receipt?.undoable || receipt.undoneAt || lock.current) return
    lock.current = true; writing.current = true; setPhase('undoing'); setError('')
    let undone: TimetableImportReceipt | null = null
    try {
      const result = await localApi<unknown>(`/operations/${encodeURIComponent(receipt.id)}/undo`, {})
      if (!isReceipt(result) || result.id !== receipt.id || !result.undoneAt) throw new Error('UNCONFIRMED_UNDO')
      undone = { ...receipt, undoneAt: result.undoneAt, undoable: false }
      if (active.current) setReceipt(undone)
      const restored = await localApi<PlannerState>('/planner')
      if (saved.importedIds.some(id => restored.routines.some(row => row.id === id))) throw new Error('STALE_RESTORE')
      if (active.current) { setPlanner(restored); setUndoVerified(true) }
      await notify(restored, undone)
    } catch (reason) {
      if (active.current) setError(undone ? '撤销已完成，但日程重新读取未完成，请关闭后重新进入日程。' : reason instanceof LocalApiError && reason.status === 409 ? '日程已有后续修改，本次未撤销；原导入仍保留，请到日程核对。' : '撤销结果尚未确认，已保存反馈仍保留，请重新读取日程核对。')
    } finally { writing.current = false; lock.current = false; if (active.current) setPhase('idle') }
  }

  const goBack = () => { if (zoom) setZoom(false); else setStep(step === 'codes' || manual ? 'upload' : step === 'preview' && questions.length ? 'groups' : 'codes') }
  const screen = saved ? 'saved' : zoom ? 'image' : step
  const steps = manual ? [['upload', '录入方式'], ['preview', '核对课程']] : [['upload', '选择图片'], ['codes', '选择代码'], ...(questions.length ? [['groups', '选择分组']] : []), ['preview', '核对全周']]
  const recognizeReason = loading ? '正在读取模型配置…' : !status ? '模型配置读取失败，请重新读取；也可手动录入。' : !status.configured ? '模型尚未连接，暂不能识别；可预选精细识别或手动录入。' : status.supportsVision === false ? '当前模型不支持图片，请连接视觉模型；也可手动录入。' : !original ? '先选择一张课表图片，再开始识别。' : `将发送给当前模型${status.model ? `（${status.model}）` : ''}，仅用于本次导入。`
  return <ImportSurface surfaceRef={surface} className="tti-dialog" data-step={screen} data-dragging={dragging}
    aria-labelledby={titleId} aria-describedby={hintId} aria-busy={busy} onClose={onClose} onOpenChange={onOpenChange}
    closeDisabled={phase === 'saving' || phase === 'undoing'} beforeClose={() => controller.current?.abort()} onEscape={() => { if (zoom) { setZoom(false); return true } return false }}
    onDragOver={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); if (!busy && !saved && step === 'upload') setDragging(true) }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false) }} onDrop={dropped}>
    <header className="import-header">{!saved && (zoom || step !== 'upload') && <button type="button" className="import-close import-back" data-import-back disabled={busy} onClick={goBack} aria-label="返回上一步"><ImportBackIcon /></button>}<div><h2 id={titleId}>导入课表</h2><p id={hintId}>{saved ? '导入结果' : zoom ? '对照课表原图' : '从图片整理，确认后保存'}</p></div><button type="button" className="import-close" disabled={phase === 'saving' || phase === 'undoing'} onClick={close} aria-label="关闭课表导入"><ImportCloseIcon /></button></header>
    {!saved && !zoom && <ol className="import-progress" aria-label="导入步骤">{steps.map(([value, label], index) => <li key={value} aria-current={step === value ? 'step' : undefined}><span>{index + 1}<span className="import-progress-total"> / {steps.length}</span></span><span>{label}</span></li>)}</ol>}
    <div className="import-body tti-scroll">
      <ImportStep step={screen}>
        {saved ? <section className="tti-saved" data-testid="timetable-receipt"><h3 tabIndex={-1} data-step-heading>{receipt?.undoneAt ? '本次导入已撤销' : `已保存 ${saved.importedCount} 项课程`}</h3><p className="tti-muted">{receipt?.undoneAt ? undoVerified ? '已重新读取日程，核对本次课程已移除。' : '已收到撤销回执，日程仍需重新核对。' : receipt?.summary}</p><div className="tti-saved-list">{preview.map(row => <p key={row.id}><strong>{row.subject}</strong><span>周{DAYS[(row.weekday ?? 1) - 1]} · {row.start}–{row.end}{row.location ? ` · ${row.location}` : ''}</span></p>)}</div></section>
        : zoom && original ? <section className="tti-zoom"><h3 tabIndex={-1} data-step-heading>对照原图</h3><div tabIndex={0} aria-label="可横向滚动查看课表原图"><img src={original.data} alt="课表原图，原始尺寸" /></div></section> : <>
        {step === 'upload' && <section className="tti-upload" data-testid="timetable-upload"><h3 tabIndex={-1} data-step-heading>先选择课表图片</h3><p className="tti-muted">识别成草稿后，再选择你上的课程。也可以直接手动录入。</p>
          <input ref={fileInput} className="tti-file" type="file" accept={CHAT_IMAGE_ACCEPT} onChange={picked} tabIndex={-1} disabled={frozen} />
          <div className="tti-source">
            <div className="tti-source-image">{original ? <><button type="button" className="tti-preview" disabled={busy} onClick={() => setZoom(true)}><img src={original.data} alt="课表原图预览" onLoad={event => { if (!dimensions.width) { const width = event.currentTarget.naturalWidth, height = event.currentTarget.naturalHeight; setDimensions({ width, height }); setHeaders({ headerWidth: Math.min(width - 1, Math.floor(width * .12)), headerHeight: Math.min(height - 1, Math.floor(height * .12)) }) } }} /><span>放大查看原图</span></button><button type="button" disabled={frozen} onClick={() => fileInput.current?.click()}>更换图片并清空草稿</button></> : <button type="button" className="import-drop" data-import-autofocus disabled={frozen} onClick={() => fileInput.current?.click()}><ImportFileIcon /><strong>选择课表图片</strong><small>或拖放到这里 · PNG / JPEG / WebP</small><small>单图最多 10 MiB</small></button>}</div>
            <div className="tti-upload-controls">
              <button type="button" className="tti-switch" role="switch" aria-label="精细识别" aria-checked={split} aria-describedby={`${hintId}-split`} disabled={frozen} onClick={() => { setSplit(current => !current); setImages([]) }}><span className="tti-switch-copy"><strong>精细识别</strong><span>{split ? '已开启 · 原图 + 表头裁片' : '已关闭 · 使用完整原图'}</span></span><span className="tti-switch-track" aria-hidden="true"><span /></span></button>
              <p id={`${hintId}-split`} className="tti-muted">可先开启，再选图片。细密的总课表适合使用精细识别。</p>
              {split && <details className="tti-help"><summary>裁片与表头设置</summary><p className="tti-muted">完整原图与最多 6 张保留顶部、左侧表头的 PNG 裁片一起发送，保留原始像素，总量最多 20 MiB。</p>{original ? <div className="tti-header-fields"><label>顶部表头（像素）<input type="number" min={0} max={Math.max(0, dimensions.height - 1)} value={headers.headerHeight} disabled={frozen} onChange={event => { setHeaders({ ...headers, headerHeight: event.target.valueAsNumber }); setImages([]) }} /></label><label>左侧行头（像素）<input type="number" min={0} max={Math.max(0, dimensions.width - 1)} value={headers.headerWidth} disabled={frozen} onChange={event => { setHeaders({ ...headers, headerWidth: event.target.valueAsNumber }); setImages([]) }} /></label></div> : <p className="tti-muted">选择图片后，可按原图调整表头范围。</p>}</details>}
              <div className="tti-model-status"><p className="tti-muted" id={`${hintId}-model`}>{recognizeReason}</p>{!connected && <button type="button" disabled={busy || loading} onClick={() => void load()}>重新读取模型状态</button>}</div>
              <div className="tti-manual"><span className="tti-muted">不使用图片？</span><button type="button" disabled={frozen || rows.length >= 300} onClick={addRow}>手动录入课程</button></div>
            </div>
          </div>
          <details className="tti-help"><summary>图片与识别帮助</summary><p className="tti-muted">请保留星期、节次和钟点表头。图片与草稿只用于本次导入；不会自动保存为课程。模型无法判断的格子会留到核对界面，由你补齐或移除。</p>{images.length > 1 && <div className="tti-crops">{images.slice(1).map((image, index) => <img key={image.name} src={image.data} alt={`本地裁片 ${index + 1}`} />)}</div>}</details>
        </section>}
        {step !== 'upload' && <div className="tti-draft-tools">{original && <button type="button" disabled={busy} onClick={() => setZoom(true)}>对照原图</button>}<button type="button" disabled={busy} onClick={() => setStep('upload')}>图片与识别设置</button></div>}
        {step !== 'upload' && codeWhitespace && <p className="tti-warning">识别草稿保留原串；保存时课程代码和分组的首尾空白会由日程规范化，代码数字与大小写不会改动。</p>}
        {step === 'codes' && <section data-testid="timetable-codes"><h3 tabIndex={-1} data-step-heading>你选的是哪些课？</h3><p className="tti-muted">点击原始代码即可匹配全周所有位置。Econ1 与 Econ2 等不同代码分别选择。</p>
          <div className="tti-tools">{kind === 'personal' && <button type="button" disabled={frozen} onClick={() => setCodes(new Set(selectionRows.filter(row => row.subject.trim()).map(row => row.subject)))}>使用个人课表的全部代码</button>}{commonCodes.length > 0 && <button type="button" disabled={frozen} onClick={() => setCodes(current => new Set([...current, ...commonCodes]))}>加入共同课程（{commonCodes.length} 个代码）</button>}<button type="button" disabled={frozen || !codes.size} onClick={() => setCodes(new Set())}>清空代码选择</button><button type="button" disabled={frozen || rows.length >= 300} onClick={addRow}>手动添加课程</button></div>
          {commonCodes.length > 0 && <p className="tti-muted">无备选格子的共同课程：{commonCodes.join('、')}。未自动加入，可批量加入或随时取消。</p>}
          {codeGroups.map(group => <fieldset className="tti-code-group" key={group.subjectGroup} disabled={frozen}><legend>{group.subjectGroup}</legend><div className="tti-code-chips">{group.codes.map(code => <button type="button" key={code} aria-pressed={codes.has(code)} data-testid="timetable-code" data-code={code} onClick={() => toggleCode(code)}>{code}</button>)}</div></fieldset>)}
          <p className="tti-count" role="status">已选 {codes.size} 个原始代码{rows.some(timetableNeedsReview) ? ' · 有待补格子，最终预览中可核对' : ''}</p>
          {rows.some(timetableNeedsReview) && <button type="button" disabled={frozen} onClick={() => { setPreviewIds(new Set()); setStep('preview') }}>查看待补格子</button>}
        </section>}
        {step === 'groups' && <section data-testid="timetable-groups"><h3 tabIndex={-1} data-step-heading>选择你的分组</h3><p className="tti-muted">这里只列出需要区分的组，同一个答案会用于全周。</p><details className="tti-help"><summary>分组如何匹配？</summary><p className="tti-muted">仅对同代码同一格的重复候选消歧。Eng / L&amp;L / Lit 的分组1/2共用答案；不同代码的字母组互不影响。</p></details>
          {questions.map(question => <fieldset key={question.id} className="tti-code-group" data-testid="timetable-group-question" data-question-id={question.id} disabled={frozen}><legend>{question.subjects.join(' / ')} · {question.family}</legend><div className="tti-code-chips">{question.options.map(option => <button type="button" key={option} aria-pressed={answers[question.id] === option} onClick={() => setAnswers(current => ({ ...current, [question.id]: option }))}>{option}</button>)}</div></fieldset>)}
        </section>}
        {step === 'preview' && <section data-testid="timetable-preview"><h3 tabIndex={-1} data-step-heading>核对全周 · {preview.length} 项</h3>{(blockingUnresolved.length > 0 || preview.some(pending)) && <p className="tti-warning">还有待补格子，请补齐或明确移除后再保存。</p>}<p className="tti-muted">核对代码、星期、节次和钟点，教室可留空。</p>
          {periods.length > 0 && <details className="tti-period-times" data-testid="timetable-period-times"><summary>节次时刻 · 一次核对应用全周</summary><p className="tti-muted">按截图表头填写24小时制，不预设学校作息。跨节分开填写以保留休息；这只改时刻，仍需核对星期、代码与格子位置。</p>{periods.map(period => { const example = rows.find(row => row.period === period && CLOCK.test(row.start) && CLOCK.test(row.end)); const times = periodTimes[period] ?? { start: example?.start ?? '', end: example?.end ?? '' }; return <div key={period} className="tti-period-time"><strong>第 {period} 节</strong><label>开始<input type="time" disabled={frozen} value={times.start} onChange={event => setPeriodTimes(current => ({ ...current, [period]: { ...times, start: event.target.value } }))} /></label><label>结束<input type="time" disabled={frozen} value={times.end} onChange={event => setPeriodTimes(current => ({ ...current, [period]: { ...times, end: event.target.value } }))} /></label><button type="button" disabled={frozen} onClick={() => { if (!periodTimes[period]) { try { setRows(applyTimetablePeriodTimes(rows, period, times.start, times.end)); setError('') } catch { setError('请先填写有效的24小时节次时刻。') } } else applyPeriod(period) }}>应用这个节次全周</button></div> })}</details>}
          {preview.some(row => row.uncertain) && <button type="button" disabled={frozen || preview.some(incomplete)} onClick={() => setRows(current => current.map(row => previewIds.has(row.id) && !incomplete(row) ? { ...row, uncertain: false } : row))}>已对照原图核对本次预览的代码、星期与节次</button>}
          <div className="tti-rows">{preview.map(row => <PreviewRow key={row.id} row={row} disabled={frozen} ambiguous={ambiguousIds.has(row.id)} onEdit={patch => edit(row.id, patch)} onRemove={() => remove(row.id)} />)}</div>
          <button type="button" disabled={frozen || rows.length >= 300} onClick={addRow}>补一项课程</button>
          {unresolved.length > 0 && <section className="tti-unresolved" data-testid="timetable-unresolved"><h4>待补格子 · {unresolved.length} 项</h4><p className="tti-warning">这些格子始终保留在这里。已选代码或代码不清的格子须补齐并加入预览，或明确移除后才能保存。未选代码的格子不计入本次导入。</p>{unresolved.map(row => <PreviewRow key={row.id} row={row} disabled={frozen} ambiguous={ambiguousIds.has(row.id)} onEdit={patch => edit(row.id, patch)} onRemove={() => remove(row.id)} onInclude={() => { manualIds.current.add(row.id); setPreviewIds(current => new Set([...current, row.id])) }} />)}</section>}
          <div className="tti-anchor"><label>第一周的周一{needsAnchor ? '（必填）' : '（可留空）'}<input type="date" value={anchor} disabled={frozen || loading} onChange={event => setAnchor(event.target.value)} /></label><p className="tti-muted">只支持每周、单周、双周。其他周范围会保留在备注，需核对处理，不能作为每周课程直接导入。</p></div>
          {conflicting && <p className="tti-warning">预览仍有同日重叠或重复候选，请编辑或移除后确认。</p>}
          {(preview.some(pending) || blockingUnresolved.length > 0) && <p className="tti-warning">本次选择还有未知星期或待补格子，确认导入已禁用。</p>}
          {(badAnchor || anchorMismatch) && <p className="tti-warning">请选择有效的第一周周一，并与已有设置 {planner?.firstWeekMonday ?? ''} 保持一致。</p>}
        </section>}
        {step === 'preview' && planner && <details className="tti-existing"><summary>核对已有课程（{planner.routines.filter(row => row.kind === 'class').length} 项）</summary>{planner.routines.filter(row => row.kind === 'class').map(row => <p key={row.id}>{row.title} · {row.weekdays.map(day => `周${DAYS[(day + 6) % 7]}`).join('、')} {row.start}–{row.end}</p>)}</details>}
        </>}
      </ImportStep>
      <div className="import-feedback tti-feedback" aria-live="polite">{busy && <p className="tti-progress" role="status"><strong>{phase === 'reading' ? '正在读取图片' : phase === 'preparing' ? recognitionStage === 'prepare' ? '正在整理课表图片' : '正在准备识别' : phase === 'recognizing' ? recognitionStage === 'send' ? '模型正在读取课表' : recognitionStage === 'check' ? '正在核对模型结果' : '正在识别课表' : phase === 'saving' ? '正在保存课表' : phase === 'undoing' ? '正在撤销本次导入' : ''}</strong><span>{phase === 'reading' ? '检查图片格式与尺寸' : phase === 'preparing' ? split ? '原图和表头裁片会一起发送，保持原始像素' : '保留原图，不写入日程' : phase === 'recognizing' ? recognitionStage === 'send' ? '只返回课程草稿，不显示模型思考正文' : '检查课程代码、星期、节次和待补格子' : phase === 'saving' ? '再次核对版本、重复和时间重叠' : phase === 'undoing' ? '重新读取日程，确认本次课程已移除' : ''}</span>{(phase === 'preparing' || phase === 'recognizing') && <button type="button" onClick={() => controller.current?.abort()}>停止识别</button>}</p>}{error && <p role="alert">{error}</p>}{(stale || !planner) && !loading && <button type="button" disabled={busy} onClick={() => void load()}>重新读取日程版本 · 保留草稿</button>}{loading && <p>正在读取日程版本与模型配置…</p>}</div>
    </div>
    <footer className="import-footer tti-footer"><span className="import-footer-note">{saved ? receipt?.undoneAt ? undoVerified ? '撤销结果已核对。' : '已撤销，等待日程核对。' : '已整批保存，可撤销本次导入。' : step === 'upload' ? '图片只生成草稿，确认后才保存。' : '确认导入后才写入课表。'}</span>
      {saved ? <>{receipt?.undoable && !receipt.undoneAt && <button type="button" disabled={busy} onClick={() => void undo()}>撤销本次导入</button>}<button type="button" className="import-primary" disabled={busy} onClick={close}>完成</button></> : zoom ? <button type="button" className="import-primary" onClick={() => setZoom(false)}>返回{step === 'upload' ? '图片设置' : '核对'}</button> : <>
        <button type="button" disabled={phase === 'saving' || phase === 'undoing'} onClick={close}>取消</button>
        {step === 'upload' && <>{rows.length > 0 && <button type="button" disabled={busy} onClick={() => setStep(manual ? 'preview' : 'codes')}>返回已有草稿</button>}<button type="button" className="import-primary" data-testid="timetable-recognize" aria-describedby={`${hintId}-model`} disabled={frozen || loading || !original || !connected} onClick={() => void recognize()}>{phase === 'preparing' || phase === 'recognizing' ? '正在识别…' : rows.length ? '重新识别并替换草稿' : '识别课表'}</button></>}
        {step === 'codes' && <button type="button" className="import-primary" data-testid="timetable-continue-codes" disabled={busy || !codes.size} onClick={continueCodes}>继续 · 已选 {codes.size} 个代码</button>}
        {step === 'groups' && <button type="button" className="import-primary" data-testid="timetable-continue-groups" disabled={busy || !answered} onClick={enterPreview}>继续 · 核对全周</button>}
        {step === 'preview' && <button type="button" className="import-primary" data-testid="timetable-confirm" disabled={!canSave} onClick={() => void save()}>确认导入 {preview.length} 项</button>}
      </>}
    </footer>
  </ImportSurface>
}
