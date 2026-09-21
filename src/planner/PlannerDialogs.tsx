import { useContext, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Task } from '../domain/task'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { agendaDate, localDay } from '../home/agenda'
import { taskStore } from '../stores/taskStore'
import { deadlineShortcuts } from '../xixi/deadlineShortcuts'
import { PlannerIcon as Icon } from './PlannerIcon'
import { weeklyRoutineSource } from './model'
import type { PlanBlock, PlannerAction, PlannerState, Routine, TaskPreparation } from './types'

type Act = (action: PlannerAction, expectedRevision?: number) => Promise<PlannerState>
export const EMPTY_DETAILS: TaskPreparation = { items: [], preparation: '', needsSubmission: false, submittedAt: null }
const splitItems = (text: string) => [...new Set(text.split(/[，,、\n]/u).map(item => item.trim()).filter(Boolean))]
const explain = (reason: unknown) => reason instanceof Error ? reason.message : '暂时无法保存，请重试'

export function PlannerDialog({ title, onClose, busy = false, closeRequested = false, children }: { title: string; onClose: () => void; busy?: boolean; closeRequested?: boolean; children: ReactNode }) {
  const sampling = useContext(GlassSamplingContext)
  const element = useRef<HTMLDialogElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [closing, setClosing] = useState(false)
  const [scrolling, setScrolling] = useState(false)
  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element.current?.showModal()
    const body = element.current?.querySelector<HTMLElement>('.pl-dialog-body')
    if (body) {
      const onScroll = () => {
        setScrolling(true)
        clearTimeout(scrollTimer.current)
        scrollTimer.current = setTimeout(() => setScrolling(false), 140)
      }
      body.addEventListener('scroll', onScroll, { passive: true })
      return () => { body.removeEventListener('scroll', onScroll); clearTimeout(timer.current); clearTimeout(scrollTimer.current); element.current?.close(); const target = opener.current; if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true }) }
    }
    return () => { clearTimeout(timer.current); clearTimeout(scrollTimer.current); element.current?.close(); const target = opener.current; if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true }) }
  }, [])
  const close = () => {
    if (busy || closing) return
    setClosing(true)
    timer.current = setTimeout(onClose, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180)
  }
  useEffect(() => { if (closeRequested && !busy && !closing) close() }, [closeRequested, busy, closing])
  return <GlassSamplingContext.Provider value={sampling && !closing}><dialog className="pl-dialog" ref={element} data-closing={closing} data-scrolling={scrolling} aria-label={title} onCancel={event => { event.preventDefault(); close() }} onKeyDown={event => event.stopPropagation()}>
    <MeasuredGlassSurface radius={22} material={{ transmission: 20, blur: 6, rim: 40, shadow: 30 }} />
    <header className="pl-dialog-header"><h2>{title}</h2><button type="button" className="pl-icon-button" onClick={close} disabled={busy} aria-label={`关闭${title}`}><Icon name="close" /></button></header>
    <div className="pl-dialog-body">{children}</div>
  </dialog></GlassSamplingContext.Provider>
}

export function RoutineDialog({ routine, source, state, act, onClose, onNotice, onBrowseRoutines }: { routine?: Routine; source?: { date: string; weekday: number }; state: PlannerState; act: Act; onClose: () => void; onNotice: (text: string) => void; onBrowseRoutines: () => void }) {
  const original = routine ? weeklyRoutineSource(state, routine, source?.weekday) : undefined
  const [draft, setDraft] = useState<Routine>(original ?? routine ?? { id: crypto.randomUUID(), title: '', kind: 'class', weekdays: [1,2,3,4,5], start: '08:00', end: '08:40', location: '', items: [], enabled: true })
  const [items, setItems] = useState(draft.items.join('、'))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [deleting, setDeleting] = useState(false)
  const [finished, setFinished] = useState(false)
  const missing = Boolean(routine && !original) && !finished
  const [baseRevision, setBaseRevision] = useState(state.revision)
  const stale = baseRevision !== state.revision
  const reload = () => {
    const latest = routine ? weeklyRoutineSource(state, routine, source?.weekday) : undefined
    if (routine && !latest) { setError('这项安排已被移除，请关闭后重新添加'); return }
    if (latest) { setDraft(latest); setItems(latest.items.join('、')) }
    setBaseRevision(state.revision); setError(''); setDeleting(false)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy || stale || missing) return
    setBusy(true); setError('')
    try { const saved = await act({ type: 'save-routine', routine: { ...draft, title: draft.title.trim(), items: splitItems(items) } }, baseRevision); setBaseRevision(saved.revision); onNotice('每周安排已保存'); setFinished(true) }
    catch (reason) { setError(explain(reason)) } finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy || stale || missing) return
    if (!deleting) { setDeleting(true); return }
    setBusy(true)
    try { const saved = await act({ type: 'delete-routine', id: draft.id }, baseRevision); setBaseRevision(saved.revision); onNotice('已移除这项每周安排'); setFinished(true) }
    catch (reason) { setError(explain(reason)) } finally { setBusy(false) }
  }
  return <PlannerDialog title={routine ? '编辑每周安排' : '添加每周安排'} onClose={onClose} busy={busy} closeRequested={finished}>
    {source && <p className="pl-muted pl-routine-scope" role="note">{source.date} 临时按周{['日','一','二','三','四','五','六'][source.weekday]}课表。这里修改来源的每周安排，影响下方选中的重复星期；今天及以后的相关调课日会同步，过去的记录保留。</p>}
    {missing ? <div className="pl-stale" role="alert"><p>这项安排已被移除或改到了其他星期。这里保留原记录，可以前往每周安排编辑现在的课表。</p><button type="button" className="pl-secondary" onClick={onBrowseRoutines}>查看每周安排</button></div>
      : stale && <div className="pl-stale" role="alert"><p>日程已有新修改，请先载入最新内容再保存</p><button className="pl-secondary" onClick={reload}>载入最新内容 · 替换草稿</button></div>}
    <form className="pl-form" onSubmit={save}><fieldset disabled={busy || stale || missing}>
      <label>名称<input required maxLength={100} value={draft.title} placeholder="例如 物理课、晚自习、通勤" onChange={e => setDraft({ ...draft, title: e.target.value })} /></label>
      <label>这段时间用来<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as Routine['kind'] })}><option value="class">课程或固定活动 · 占用时间</option><option value="available">空课或自习 · 可以安排任务</option><option value="break">吃饭、休息或通勤 · 留给自己</option></select></label>
      <div className="pl-form-pair"><label>开始<input required type="time" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} /></label><label>结束<input required type="time" value={draft.end} onChange={e => setDraft({ ...draft, end: e.target.value })} /></label></div>
      <div><span className="pl-label">每周重复</span><div className="pl-weekday-picks" role="group" aria-label="重复星期">{[1,2,3,4,5,6,0].map(day => <button key={day} type="button" aria-pressed={draft.weekdays.includes(day)} onClick={() => setDraft({ ...draft, weekdays: draft.weekdays.includes(day) ? draft.weekdays.filter(d => d !== day) : [...draft.weekdays, day] })}>{['日','一','二','三','四','五','六'][day]}</button>)}</div></div>
      <label>地点<input maxLength={100} value={draft.location} placeholder="可留空" onChange={e => setDraft({ ...draft, location: e.target.value })} /></label>
      <label>需要携带<input maxLength={500} value={items} placeholder="例如 电脑、充电器，用顿号分隔" onChange={e => setItems(e.target.value)} /></label>
      <label className="pl-checkbox"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用这项安排</label>
      <p className="pl-muted">空课和晚自习计入可支配时间，固定活动与休息会从中扣除</p>
      {error && <p className="pl-error" role="alert">{error}</p>}
      <footer>{routine && <button className="pl-delete" type="button" onClick={() => void remove()}>{deleting ? '确认移除' : '移除'}</button>}<button className="pl-primary" type="submit">{busy ? '保存中' : '保存安排'}</button></footer>
    </fieldset></form>
  </PlannerDialog>
}

export function TaskPlanDialog({ task, state, selected, act, onClose, onNotice, onRefresh }: { task: Task; state: PlannerState; selected: string; act: Act; onClose: () => void; onNotice: (text: string) => void; onRefresh: () => void }) {
  const details = state.details[task.id] ?? EMPTY_DETAILS
  const [items, setItems] = useState(details.items.join('、')), [preparation, setPreparation] = useState(details.preparation)
  const [needsSubmission, setNeedsSubmission] = useState(details.needsSubmission)
  const existing = state.blocks.filter(block => block.taskId === task.id)
  const [editing, setEditing] = useState<PlanBlock>({ id: crypto.randomUUID(), taskId: task.id, date: selected, start: '18:00', end: '18:35', locked: false })
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [baseRevision, setBaseRevision] = useState(state.revision)
  const stale = baseRevision !== state.revision
  const reload = () => {
    setItems(details.items.join('、')); setPreparation(details.preparation); setNeedsSubmission(details.needsSubmission)
    setEditing(existing.find(block => block.id === editing.id) ?? { id: crypto.randomUUID(), taskId: task.id, date: selected, start: '18:00', end: '18:35', locked: false })
    setBaseRevision(state.revision); setRemoving(null); setError('')
  }
  const execute = async (action: PlannerAction, message: string) => {
    if (busy || stale) return
    setBusy(true); setError('')
    try { const saved = await act(action, baseRevision); setBaseRevision(saved.revision); onNotice(message) }
    catch (reason) { setError(explain(reason)) } finally { setBusy(false) }
  }
  const originalDate = agendaDate(task.startAt)
  return <PlannerDialog title="事项与安排" onClose={onClose} busy={busy}>
    <p className="pl-dialog-task-title">{task.title}</p>
    <p className="pl-muted">{task.due ? `截止 ${task.due.length === 10 ? task.due : new Date(task.due).toLocaleString('zh-CN', { hour12: false })}` : '尚未设置截止日期'} · {task.estimateMin ? `预计 ${task.estimateMin} 分钟` : '用时待估'}</p>
    {stale && <div className="pl-stale" role="alert"><p>日程已有新修改，当前草稿尚未覆盖它</p><button className="pl-secondary" onClick={reload}>载入最新内容 · 替换草稿</button></div>}
    {error && <p className="pl-error" role="alert">{error}</p>}
    <form className="pl-form" onSubmit={event => { event.preventDefault(); void execute({ type: 'save-details', taskId: task.id, details: { items: splitItems(items), preparation: preparation.trim(), needsSubmission, submittedAt: needsSubmission ? details.submittedAt : null } }, '准备事项已保存') }}><fieldset disabled={busy || stale}>
      <h3><Icon name="bag" /> 出门前准备</h3>
      <label>要带的东西<input value={items} maxLength={500} placeholder="例如 电脑、充电器、纸质报告" onChange={e => setItems(e.target.value)} /></label>
      <label>提前做的一步<textarea rows={2} maxLength={500} value={preparation} placeholder="例如 今晚打印报告，电脑充电" onChange={e => setPreparation(e.target.value)} /></label>
      <label className="pl-checkbox"><input type="checkbox" checked={needsSubmission} onChange={e => setNeedsSubmission(e.target.checked)} />完成后还需要提交</label>
      <footer><button className="pl-secondary" type="submit">保存准备信息</button></footer>
    </fieldset></form>
    {details.needsSubmission && <div className="pl-submission"><span>{details.submittedAt ? '已确认提交' : task.status === 'done' ? '已经做完，提交待确认' : '做完后记得确认提交'}</span><button className="pl-secondary" disabled={busy || stale} onClick={() => void execute({ type: 'save-details', taskId: task.id, details: { ...details, submittedAt: details.submittedAt ? null : new Date().toISOString() } }, details.submittedAt ? '已撤回提交确认' : '已确认提交')}><Icon name={details.submittedAt ? 'undo' : 'check'} />{details.submittedAt ? '撤回' : '已提交'}</button></div>}
    <section className="pl-existing-plans"><h3><Icon name="clock" /> 安排时间</h3>
      {existing.length === 0 && originalDate && task.startAt?.includes('T') && <p className="pl-muted">原计划 {localDay(originalDate)} {originalDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} · 新增具体时段后以新安排为准</p>}
      {existing.map(block => <div className="pl-plan-row" key={block.id}><span>{block.date}　{block.start}–{block.end}{block.locked && <Icon name="lock" />}</span><div>{block.locked ? <button className="pl-secondary" disabled={busy || stale} onClick={() => void execute({ type: 'save-block', block: { ...block, locked: false } }, '已解锁时段')}>解锁</button> : <>{task.status !== 'done' && task.status !== 'dropped' && <button className="pl-icon-button" disabled={busy || stale} title="编辑时段" aria-label={`编辑 ${block.date} ${block.start} 时段`} onClick={() => setEditing(block)}><Icon name="edit" /></button>}<button className="pl-icon-button" disabled={busy || stale} title={removing === block.id ? '确认移除' : '移除时段'} aria-label={removing === block.id ? '确认移除时段' : `移除 ${block.date} ${block.start} 时段`} onClick={() => { if (removing !== block.id) { setRemoving(block.id); return } void execute({ type: 'delete-block', id: block.id }, '已移除时段') }}><Icon name={removing === block.id ? 'check' : 'close'} /></button></>}</div></div>)}
    </section>
    {task.status !== 'done' && task.status !== 'dropped' && <form className="pl-form" onSubmit={async event => {
      event.preventDefault(); if (busy || stale) return
      setBusy(true); setError('')
      try { const saved = await act({ type: 'save-block', block: editing }, baseRevision); setBaseRevision(saved.revision); onNotice('计划已写入日历'); setEditing({ ...editing, id: crypto.randomUUID() }) }
      catch (reason) { setError(explain(reason)) } finally { setBusy(false) }
    }}><fieldset disabled={busy || stale}>
      <label>日期<input type="date" required value={editing.date} onChange={e => setEditing({ ...editing, date: e.target.value })} /></label>
      <div className="pl-form-pair"><label>开始<input type="time" required value={editing.start} onChange={e => setEditing({ ...editing, start: e.target.value })} /></label><label>结束<input type="time" required value={editing.end} onChange={e => setEditing({ ...editing, end: e.target.value })} /></label></div>
      <label className="pl-checkbox"><input type="checkbox" checked={editing.locked} onChange={e => setEditing({ ...editing, locked: e.target.checked })} />锁定这段时间</label>
      <footer>{existing.some(b => b.id === editing.id) && <button className="pl-secondary" type="button" onClick={() => setEditing({ ...editing, id: crypto.randomUUID() })}>改为新增</button>}<button className="pl-primary" type="submit">{existing.some(b => b.id === editing.id) ? '更新时段' : '添加时段'}</button></footer>
    </fieldset></form>}
    <div className="pl-task-status-actions"><span>{task.status === 'done' ? '任务已完成' : task.status === 'doing' ? '任务进行中' : '任务待办'}</span><button className="pl-secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError('')
      try { if (task.status === 'done') await taskStore.reopenTask(task.id, task.updatedAt); else await taskStore.updateTask(task.id, { status: 'done' }, task.updatedAt); onRefresh(); onNotice(task.status === 'done' ? '已撤回完成，恢复原状态' : '任务已完成') }
      catch (reason) { setError(explain(reason)) } finally { setBusy(false) }
    }}><Icon name={task.status === 'done' ? 'undo' : 'check'} />{task.status === 'done' ? '撤回完成' : '标记完成'}</button></div>
  </PlannerDialog>
}

export function CreateTaskDialog({ selected, onClose, onRefresh, onNotice }: { selected: string; onClose: () => void; onRefresh: () => void; onNotice: (text: string) => void }) {
  const [title, setTitle] = useState(''), [due, setDue] = useState(selected), [dueTime, setDueTime] = useState(''), [estimate, setEstimate] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [finished, setFinished] = useState(false)
  return <PlannerDialog title="记录一件事" onClose={onClose} busy={busy} closeRequested={finished}><form className="pl-form" onSubmit={async event => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError('')
    try {
      await taskStore.createTask({ title: title.trim(), due: due ? dueTime ? new Date(`${due}T${dueTime}`).toISOString() : due : undefined, estimateMin: estimate ? Number(estimate) : undefined, area: null, source: 'manual', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo' })
      onRefresh(); onNotice('事项已加入日历'); setFinished(true)
    } catch (reason) { setError(explain(reason)) } finally { setBusy(false) }
  }}><fieldset disabled={busy}>
    <label>事情<input autoFocus required value={title} maxLength={160} placeholder="例如 交物理报告" onChange={e => setTitle(e.target.value)} /></label>
    <div className="pl-form-pair"><label>截止日期<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label><label>截止时刻 · 可不填<input type="time" value={dueTime} onChange={e => setDueTime(e.target.value)} disabled={!due} /></label></div>
    <div className="pl-deadline-shortcuts" role="group" aria-label="快捷选择截止日期">{deadlineShortcuts(new Date()).map(option => <button type="button" className="pl-secondary" key={option.date} aria-pressed={due === option.date} onClick={() => setDue(option.date)}>{option.label}</button>)}</div>
    <label>预计用时 · 分钟<input type="number" min="1" max="1440" value={estimate} placeholder="未确定可留空" onChange={e => setEstimate(e.target.value)} /></label>
    <p className="pl-muted">截止日期是交付时间，具体什么时候做可以稍后安排</p>
    {error && <p className="pl-error" role="alert">{error}</p>}<footer><button className="pl-primary" type="submit">记下</button></footer>
  </fieldset></form></PlannerDialog>
}
