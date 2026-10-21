import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ImportSurface, ImportStep, ImportCloseIcon, ImportBackIcon, ImportFileIcon } from './ImportSurface'
import type { ImportSurfaceHandle, ImportSurfaceParentProps } from './ImportSurface'
import { localApi } from '../xixi/api'
import type { PlannerState } from './types'
import './ics-timetable-import.css'

type Row = { id: string; date: string; start: string; end: string; subject: string; location: string; note: string }
type Preview = { draft: { rows: Row[]; timezone: string } }
type Receipt = { id: string; undoable: boolean; undoneAt?: string | null }
type Confirmed = { state: PlannerState; importedCount: number; importedIds: string[]; operation: Receipt }
type Props = ImportSurfaceParentProps & { onClose: () => void; onSaved: (state: PlannerState) => void | Promise<void> }
const explain = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试；草稿已保留'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validDay = (value: string) => /^[1-9]\d{3}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const clock = (value: string) => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)
const validRow = (row: Row) => validDay(row.date) && clock(row.start) && clock(row.end) && row.start < row.end && !!row.subject.trim() && row.subject.length <= 160 && row.location.length <= 160
const isState = (value: unknown): value is PlannerState => record(value) && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
  && Array.isArray(value.routines) && Array.isArray(value.blocks) && Array.isArray(value.dayEvents) && record(value.details) && record(value.checked)

function readPreview(value: unknown, timezone: string): Preview {
  if (!record(value) || !record(value.draft) || value.draft.timezone !== timezone || !Array.isArray(value.draft.rows)
    || !value.draft.rows.length || value.draft.rows.length > 1000) throw new Error('预览内容不完整，请重新选择 ICS 文件')
  const ids = new Set<string>()
  for (const row of value.draft.rows) {
    if (!record(row) || !['id', 'date', 'start', 'end', 'subject', 'location', 'note'].every(key => typeof row[key] === 'string')
      || !row.id || ids.has(String(row.id)) || !validRow(row as Row)) throw new Error('预览课程格式不完整，请重新选择文件')
    ids.add(String(row.id))
  }
  return value as Preview
}

function readConfirmation(value: unknown, rows: Row[], revision: number): Confirmed {
  if (!record(value) || !isState(value.state) || value.state.revision !== revision + rows.length || value.importedCount !== rows.length
    || !Array.isArray(value.importedIds) || value.importedIds.length !== rows.length || new Set(value.importedIds).size !== rows.length
    || !value.importedIds.every(id => typeof id === 'string' && !!id) || !record(value.operation) || typeof value.operation.id !== 'string'
    || !value.operation.id || value.operation.undoable !== true || value.operation.undoneAt) throw new Error('保存结果尚未完整核对，请重新核对日程后再操作；草稿已保留')
  for (const [index, row] of rows.entries()) {
    const saved = value.state.dayEvents?.find(event => event.id === (value.importedIds as string[])[index])
    if (!saved || saved.date !== row.date || saved.start !== row.start || saved.end !== row.end || saved.title !== row.subject.trim()
      || saved.location !== row.location.trim() || !Array.isArray(saved.items) || saved.items.length) throw new Error('未能核对全部导入课程，请重新核对日程；草稿已保留')
  }
  return value as Confirmed
}

/** Mount only after a deliberate user action. Opening/previewing never writes. */
export function IcsTimetableImport({ onClose, onSaved, onOpenChange }: Props) {
  const surface = useRef<ImportSurfaceHandle>(null), fileInput = useRef<HTMLInputElement>(null)
  const lock = useRef(false), mounted = useRef(false), controller = useRef<AbortController | null>(null)
  const titleId = useId(), helpId = useId()
  const [rows, setRows] = useState<Row[]>([]), [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [subject, setSubject] = useState(''), [location, setLocation] = useState('')
  const [timezone, setTimezone] = useState(''), [filename, setFilename] = useState('')
  const [revision, setRevision] = useState<number | null>(null), [phase, setPhase] = useState('')
  const [error, setError] = useState(''), [dragging, setDragging] = useState(false)
  const [saved, setSaved] = useState<Confirmed | null>(null), [undone, setUndone] = useState(false)
  const [notice, setNotice] = useState('')
  const [step, setStep] = useState<'upload' | 'preview'>('upload')
  const busy = !!phase
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; controller.current?.abort() }
  }, [])
  const visible = useMemo(() => rows.filter(row => row.subject.toLocaleLowerCase().includes(subject.trim().toLocaleLowerCase())
    && row.location.toLocaleLowerCase().includes(location.trim().toLocaleLowerCase())), [rows, subject, location])
  const chosen = rows.filter(row => selected.has(row.id))
  const invalid = chosen.filter(row => !validRow(row)).length
  const hiddenSelected = chosen.length - visible.filter(row => selected.has(row.id)).length
  const begin = (text: string) => {
    if (lock.current) return null
    lock.current = true; setPhase(text); setError(''); setNotice('')
    const next = new AbortController(); controller.current = next
    return next.signal
  }
  const finish = () => { lock.current = false; if (mounted.current) setPhase('') }
  const publish = async (state: PlannerState) => {
    try { await onSaved(state) }
    catch { if (mounted.current) setNotice('本机日程已保存，页面刷新暂未完成；关闭后重新打开日程即可核对。') }
  }
  const readFile = async (file: File) => {
    const signal = begin('读取 ICS 课表…')
    if (!signal) return
    try {
      if (!/\.ics$/iu.test(file.name)) throw new Error('请选择 .ics 格式的日历文件')
      if (!file.size || file.size > 1024 * 1024) throw new Error('ICS 文件需要有内容，且不能超过 1 MiB')
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const text = await file.text()
      if (signal.aborted) return
      setPhase('展开课程并读取日程版本…')
      const [previewValue, state] = await Promise.all([
        localApi<unknown>('/planner/import/ics/preview', { text, timezone: zone }, { signal }),
        localApi<unknown>('/planner', undefined, { signal }),
      ])
      const preview = readPreview(previewValue, zone)
      if (!isState(state)) throw new Error('未能读取日程版本，请重新核对日程')
      if (!mounted.current) return
      setRows(preview.draft.rows); setTimezone(zone); setFilename(file.name); setSelected(new Set())
      setRevision(state.revision); setStep('preview'); setSubject(''); setLocation(''); setSaved(null); setUndone(false)
    } catch (reason) { if (mounted.current && !signal.aborted) setError(explain(reason)) }
    finally { finish(); if (fileInput.current) fileInput.current.value = '' }
  }
  const reloadRevision = async () => {
    const signal = begin('重新核对日程…')
    if (!signal) return
    try {
      const state = await localApi<unknown>('/planner', undefined, { signal })
      if (!isState(state)) throw new Error('日程数据不完整，暂时不能确认导入')
      if (mounted.current) { setRevision(state.revision); setNotice('已读取最新日程，草稿和选择已保留。确认时会再次检查冲突。') }
    } catch (reason) { if (mounted.current && !signal.aborted) setError(explain(reason)) }
    finally { finish() }
  }
  const confirm = async () => {
    if (saved || revision === null || !chosen.length || invalid) return
    const signal = begin('核对冲突并保存课程…')
    if (!signal) return
    try {
      const result = readConfirmation(await localApi<unknown>('/planner/import/ics/confirm', { rows: chosen, expectedRevision: revision }, { signal }), chosen, revision)
      if (!mounted.current) return
      setSaved(result); setRevision(result.state.revision)
      await publish(result.state)
    } catch (reason) { if (mounted.current && !signal.aborted) setError(explain(reason)) }
    finally { finish() }
  }
  const undo = async () => {
    if (!saved || undone) return
    const signal = begin('撤销本次导入…')
    if (!signal) return
    try {
      const receipt = await localApi<unknown>(`/operations/${encodeURIComponent(saved.operation.id)}/undo`, {}, { signal })
      if (!record(receipt) || receipt.id !== saved.operation.id || typeof receipt.undoneAt !== 'string' || !receipt.undoneAt) throw new Error('撤销回执尚未核对，请重试核对撤销结果')
      const state = await localApi<unknown>('/planner', undefined, { signal })
      if (!isState(state) || state.revision <= saved.state.revision || state.dayEvents?.some(event => saved.importedIds.includes(event.id))) throw new Error('撤销后的日程尚未核对，请重试核对撤销结果')
      if (!mounted.current) return
      setUndone(true); setRevision(state.revision)
      await publish(state)
    } catch (reason) { if (mounted.current && !signal.aborted) setError(explain(reason)) }
    finally { finish() }
  }
  const edit = (id: string, key: keyof Omit<Row, 'id'>, value: string) => setRows(previous => previous.map(row => row.id === id ? { ...row, [key]: value } : row))
  const selectVisible = () => setSelected(previous => new Set([...previous, ...visible.map(row => row.id)]))
  const close = () => { if (!lock.current) surface.current?.close() }
  const screen = saved ? 'saved' : step
  return <ImportSurface surfaceRef={surface} className="ics-import" data-step={screen} data-dragging={dragging}
    aria-labelledby={titleId} aria-describedby={helpId} aria-busy={busy} onClose={onClose} onOpenChange={onOpenChange} closeDisabled={busy}
    onDragOver={event => { if (!event.dataTransfer.types.includes('Files')) return; event.preventDefault(); event.stopPropagation(); if (!busy && !saved && step === 'upload') setDragging(true) }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes('Files')) return
      event.preventDefault(); event.stopPropagation(); setDragging(false)
      if (lock.current || saved || step !== 'upload') return
      if (event.dataTransfer.files.length !== 1) { setError('每次请选择一份 ICS 文件'); return }
      void readFile(event.dataTransfer.files[0])
    }}>
    <header className="import-header">{!saved && step === 'preview' && <button type="button" className="import-close import-back" data-import-back disabled={busy} onClick={() => setStep('upload')} aria-label="返回选择文件"><ImportBackIcon /></button>}<div><h2 id={titleId}>导入 ICS 课表</h2><p id={helpId}>{saved ? '导入结果' : '按实际日期整理，确认后保存'}</p></div><button type="button" className="import-close" onClick={close} disabled={busy} aria-label="关闭 ICS 导入"><ImportCloseIcon /></button></header>
    {!saved && <ol className="import-progress" aria-label="ICS 导入步骤"><li aria-current={step === 'upload' ? 'step' : undefined}><span>1<span className="import-progress-total"> / 2</span></span><span>选择文件</span></li><li aria-current={step === 'preview' ? 'step' : undefined}><span>2<span className="import-progress-total"> / 2</span></span><span>核对课程</span></li></ol>}
    <div className="import-body ics-import-body">
      <ImportStep step={screen}>
        {saved ? <section className="ics-import-receipt" aria-label="导入回执"><h3 tabIndex={-1} data-step-heading>{undone ? '本次导入已撤销' : `已保存 ${saved.importedCount} 项课程`}</h3>
          <p className="ics-import-muted">{undone ? `已核对本次 ${saved.importedCount} 项课程已从日程移除。` : '已逐项核对日期、时刻、科目和地点，可撤销本次导入。'}</p>
          <ul>{saved.importedIds.map(id => { const event = saved.state.dayEvents?.find(item => item.id === id); return event && <li key={id}><time>{event.date} {event.start}–{event.end}</time><span>{event.title}{event.location ? ` · ${event.location}` : ''}</span></li> })}</ul>
        </section> : step === 'upload' ? <section className="ics-import-upload"><h3 tabIndex={-1} data-step-heading>先选择 ICS 文件</h3><p className="ics-import-muted">先读取课程草稿，下一步选择需要导入的课程。</p>
          <input ref={fileInput} type="file" accept=".ics,text/calendar" aria-label="选择 ICS 文件" hidden disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (file) void readFile(file) }} />
          <button type="button" className="import-drop" data-import-autofocus onClick={() => fileInput.current?.click()} disabled={busy}><ImportFileIcon /><strong>{rows.length ? '更换 ICS 文件' : '选择 ICS 文件'}</strong><small>或拖放到这里 · 最多 1 MiB</small></button>
          {filename && <p className="ics-import-muted">当前草稿：{filename} · {rows.length} 项</p>}
          <details className="ics-import-help"><summary>支持哪些课程？</summary><p className="ics-import-muted">支持单次课程和有终点的每周 / 隔周课程。全天、跨日课程需先补齐或拆分时刻。课程会展开为实际日期，核对时可筛选、编辑和选择，不会自动写入。</p></details>
        </section> : <section data-testid="ics-timetable-preview"><h3 tabIndex={-1} data-step-heading>选择并核对课程</h3><p className="ics-import-muted">{filename} · {rows.length} 项 · 只导入你选中的课程。</p>
            <div className="ics-import-filters">
              <label>科目筛选<input type="search" value={subject} disabled={busy} placeholder="全部科目" onChange={event => setSubject(event.target.value)} /></label>
              <label>地点筛选<input type="search" value={location} disabled={busy} placeholder="全部地点" onChange={event => setLocation(event.target.value)} /></label>
            </div>
            <div className="ics-import-tools">
              <button type="button" disabled={busy} onClick={() => setSelected(new Set(rows.map(row => row.id)))}>全选 {rows.length} 项</button>
              <button type="button" disabled={busy || !visible.length} onClick={selectVisible}>选中筛选结果 {visible.length} 项</button>
              <button type="button" disabled={busy || !selected.size} onClick={() => setSelected(new Set())}>清空选择</button>
              <span className="ics-import-muted" role="status">已选 {chosen.length} / {rows.length}{hiddenSelected > 0 ? ` · 含隐藏的 ${hiddenSelected} 项` : ''}</span>
            </div>
            <p className="ics-import-table-hint ics-import-muted">左右滑动列表，核对科目与地点。</p>
            <div className="ics-import-table-scroll" tabIndex={0} aria-label="可编辑课程列表">
              <table><thead><tr><th scope="col">选择</th><th scope="col">科目</th><th scope="col">日期</th><th scope="col">开始</th><th scope="col">结束</th><th scope="col">地点</th></tr></thead>
                <tbody>{visible.map((row, index) => <tr key={row.id} data-selected={selected.has(row.id)}>
                  <td><button type="button" className="ics-import-pick" disabled={busy} aria-pressed={selected.has(row.id)} aria-label={`选择第 ${index + 1} 行 ${row.subject} ${row.date}`} onClick={() => {
                    setSelected(previous => { const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next })
                  }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8 2.5 2.5L12 5" /></svg></button></td>
                  <td><input disabled={busy} maxLength={160} aria-label={`第 ${index + 1} 行科目`} value={row.subject} aria-invalid={!row.subject.trim()} onChange={event => edit(row.id, 'subject', event.target.value)} />
                    {row.note && <details><summary>原备注</summary><p>{row.note}</p></details>}</td>
                  <td><input type="date" disabled={busy} aria-label={`第 ${index + 1} 行日期`} value={row.date} aria-invalid={!validDay(row.date)} onChange={event => edit(row.id, 'date', event.target.value)} /></td>
                  <td><input type="time" step="60" disabled={busy} aria-label={`第 ${index + 1} 行开始`} value={row.start} aria-invalid={!clock(row.start) || row.start >= row.end} onChange={event => edit(row.id, 'start', event.target.value)} /></td>
                  <td><input type="time" step="60" disabled={busy} aria-label={`第 ${index + 1} 行结束`} value={row.end} aria-invalid={!clock(row.end) || row.start >= row.end} onChange={event => edit(row.id, 'end', event.target.value)} /></td>

                  <td><input disabled={busy} maxLength={160} aria-label={`第 ${index + 1} 行地点`} value={row.location} onChange={event => edit(row.id, 'location', event.target.value)} /></td>
                </tr>)}</tbody></table>
              {!visible.length && <p className="ics-import-muted">没有符合筛选的课程，已勾选的其他课程仍保留。</p>}
            </div>
            <p className="ics-import-muted">时区：{timezone} · 原备注只供核对，不会写入携带清单。{invalid > 0 ? `已选课程有 ${invalid} 行需要补齐日期、时刻或科目。` : '默认未选择，只有勾选的课程会被导入。'}</p>
          <details className="ics-import-help"><summary>日期与时区帮助</summary><p className="ics-import-muted">课程按照文件中的实际日期和 {timezone} 时区展开。原备注供核对，不会写入携带清单。修改日期和时刻后，确认时会重新检查冲突。</p></details>
        </section>}
      </ImportStep>
      <div className="import-feedback" aria-live="polite">{phase && <p role="status">{phase}</p>}{error && <p className="ics-import-error" role="alert">{error}</p>}{notice && <p className="ics-import-muted" role="status">{notice}</p>}</div>
    </div>
    <footer className="import-footer ics-import-footer"><span className="import-footer-note">{saved ? undone ? '撤销结果已核对。' : '已整批保存，可撤销本次导入。' : step === 'upload' ? '选择文件只生成草稿。' : `已选 ${chosen.length} 项，确认后才保存。`}</span>
      {saved ? <>{!undone && <button type="button" disabled={busy} onClick={() => void undo()}>撤销本次导入</button>}<button type="button" className="import-primary" disabled={busy} onClick={close}>完成</button></> : <>
        <button type="button" onClick={close} disabled={busy}>取消</button>
        {step === 'upload' && rows.length > 0 && <button type="button" className="import-primary" disabled={busy} onClick={() => setStep('preview')}>返回已有草稿</button>}
        {step === 'preview' && <><button type="button" onClick={() => void reloadRevision()} disabled={busy}>重新核对日程</button><button className="import-primary" data-testid="ics-timetable-confirm" type="button" onClick={() => void confirm()} disabled={busy || revision === null || !chosen.length || !!invalid}>确认导入 {chosen.length} 项</button></>}
      </>}
    </footer>
  </ImportSurface>
}
