import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import type { Task } from '../domain/task'
import { agendaDate, localDay } from '../home/agenda'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import type { GlassMaterial } from '../home/GlassSurface'
import { WorkbenchIcon } from '../workbench/WorkbenchIcon'
import { LOCAL_DATA_CHANGE, notifyLocalDataChange } from '../stores/migration'
import { usePlanner } from '../planner/usePlanner'
import { localApi } from './api'
import { usePreferences } from './preferences'
import { DecisionStudio } from './DecisionStudio'
import { beginDecisionExit, DECISION_CONTENT_EXIT_MS, DECISION_ENTER_MS, DECISION_EXIT_MS, DECISION_REVEAL_MS, getDecisionEffect, setDecisionEffect } from '../prototype/decisionEffect'
import type { CompanionState, Handoff, Wish } from './companionTypes'
import './companion.css'
import './decision-studio.css'

type Tab = 'scenarios' | 'wishes' | 'opportunities'
type Props = {
  tasks: Task[]
  tasksLoading: boolean
  tasksError: string
  onChanged: () => void | Promise<void>
  onNotice: (message: string) => void
  initialTab?: Tab
  initialScenarioId?: string
  exiting?: boolean
  onExited?: () => void
  onRevealDestination?: () => void
}
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'scenarios', label: '决策推演' }, { id: 'wishes', label: '牵挂清单' }, { id: 'opportunities', label: '合适的时机' }]
const GLASS_RELEASE_MS = 240
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(agendaDate(value) ?? new Date())
const duration = (value: number) => {
  const minutes = Math.max(0, Math.floor(value))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`
}
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '暂时没有完成，请重试'

export function CompanionPanel({ tasks, tasksLoading, tasksError, onChanged, onNotice, initialTab = 'scenarios', initialScenarioId, exiting = false, onExited, onRevealDestination }: Props) {
  const preferences = usePreferences().value
  const planner = usePlanner(true)
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [pendingTab, setPendingTab] = useState<Tab | null>(null)
  const [sampling, setSampling] = useState(true)
  const leaving = exiting || pendingTab !== null
  const departure = useRef({ exiting, pendingTab, onExited, onRevealDestination })
  departure.current = { exiting, pendingTab, onExited, onRevealDestination }
  const reducedMotion = preferences.effect.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches
  const requestTab = (next: Tab) => {
    if (next === tab) { setPendingTab(null); return }
    if (reducedMotion) { setTab(next); setPendingTab(null) }
    else setPendingTab(next)
  }
  const [date, setDate] = useState(() => localDay(new Date()))
  const [state, setState] = useState<CompanionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const actionLock = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const loadRevision = useRef(0)
  const refresh = useCallback(async () => {
    const revision = ++loadRevision.current
    const next = await localApi<CompanionState>(`/companion?date=${encodeURIComponent(date)}&days=7`)
    if (revision === loadRevision.current) setState(next)
  }, [date])
  useEffect(() => { heading.current?.focus({ preventScroll: true }); return () => { loadRevision.current += 1 } }, [])
  useEffect(() => { requestTab(initialTab) }, [initialTab, initialScenarioId])
  useEffect(() => {
    if (!leaving) {
      setSampling(true)
      const current = getDecisionEffect()
      if (current.active) setDecisionEffect(current)
      return
    }
    if (tab === 'scenarios') beginDecisionExit()
    // Fade the optical layer before releasing it; removing it on the first
    // frame makes the glass edge pop even when the rest of the pane fades.
    const release = setTimeout(() => setSampling(false), reducedMotion || document.hidden ? 0 : GLASS_RELEASE_MS)
    const finish = () => {
      const latest = departure.current
      if (latest.exiting) latest.onExited?.()
      else if (latest.pendingTab) { setTab(latest.pendingTab); setPendingTab(null) }
    }
    const timer = setTimeout(finish, reducedMotion || document.hidden ? 0 : DECISION_EXIT_MS)
    return () => { clearTimeout(timer); clearTimeout(release) }
  }, [leaving, reducedMotion])
  useEffect(() => {
    if (!exiting) return
    const reveal = setTimeout(() => departure.current.onRevealDestination?.(), reducedMotion || document.hidden ? 0 : DECISION_REVEAL_MS)
    return () => clearTimeout(reveal)
  }, [exiting, reducedMotion])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    void refresh().catch(reason => { if (!cancelled) setError(errorText(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; loadRevision.current += 1 }
  }, [refresh])
  useEffect(() => {
    const reload = () => { if (!actionLock.current) void refresh().catch(reason => setError(errorText(reason))) }
    window.addEventListener(LOCAL_DATA_CHANGE, reload); window.addEventListener('focus', reload)
    return () => { window.removeEventListener(LOCAL_DATA_CHANGE, reload); window.removeEventListener('focus', reload) }
  }, [refresh])
  const action = async <T,>(operation: () => Promise<T>, success: string, changed = false): Promise<T | undefined> => {
    if (actionLock.current) return undefined
    actionLock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await operation()
      setNotice(success); onNotice(success)
      if (changed) notifyLocalDataChange()
      try { await refresh(); if (changed) { await planner.refresh(); await onChanged() } }
      catch (reason) { setError(`操作已保存，但页面尚未同步：${errorText(reason)}`) }
      return result
    } catch (reason) { setError(errorText(reason)); return undefined }
    finally { actionLock.current = false; setBusy(false) }
  }
  const material: GlassMaterial = { transmission: 70, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }
  return <section className="xc-page" data-studio={tab === 'scenarios'} data-leaving={leaving} data-exiting={exiting} data-spatial="false" data-theme={preferences.theme} data-grid={preferences.grid} data-motion={preferences.effect.motion} style={{ '--decision-enter-duration': `${DECISION_ENTER_MS}ms`, '--decision-exit-duration': `${DECISION_EXIT_MS}ms`, '--decision-reveal-duration': `${DECISION_REVEAL_MS}ms`, '--decision-glass-release': `${GLASS_RELEASE_MS}ms`, '--decision-content-duration': `${(exiting ? DECISION_CONTENT_EXIT_MS : DECISION_EXIT_MS) - GLASS_RELEASE_MS}ms` } as CSSProperties} inert={exiting} aria-hidden={exiting} aria-label="平行宇宙">
    <div className="xc-page-background" aria-hidden="true" />
    <div className="xc-page-scroll"><section className="xc-dialog" data-spatial="false" aria-labelledby={`${id}-title`}>
      <div className="xc-shell">
        <header className="xc-header"><div className="xc-heading"><span className="xc-eyebrow">PARALLEL WORLDS</span><h2 id={`${id}-title`} tabIndex={-1} ref={heading}>平行宇宙</h2></div><nav className="xc-tabs" aria-label="析熙探索分区">{TABS.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => requestTab(item.id)}>{item.label}{item.id === 'wishes' && state && <small>{state.wishes.filter(wish => wish.status === 'active').length}</small>}</button>)}</nav></header>
        <GlassSamplingContext.Provider value={sampling}><div className="xc-scroll" inert={leaving}>
          {state ? tab === 'scenarios' ? <DecisionStudio exiting={leaving} tasks={tasks} tasksLoading={tasksLoading} tasksError={tasksError} state={state} date={date} onDate={setDate} plannerRevision={planner.state?.revision} plannerLoading={planner.loading} plannerError={planner.error} loading={loading} busy={busy} action={action} material={material} initialScenarioId={initialScenarioId} /> : <section className="xc-auxiliary xc-glass"><GlassCardContent material={material}>
            <div className="xc-date-row"><label htmlFor={`${id}-date`}>从哪天看起</label><input id={`${id}-date`} type="date" value={date} disabled={busy} onChange={event => { if (event.target.value) setDate(event.target.value) }} /><span>接下来 7 天</span></div>
            {tab === 'wishes' && <Wishes wishes={state.wishes} busy={busy} action={action} />}
            {tab === 'opportunities' && <section aria-label="根据真实条件找到的机会"><div className="xc-section-heading"><div><h3>条件刚好合适</h3><p>来自可用时段、已记录的牵挂和任务准备物品</p></div></div>{state.opportunities.length ? <ul className="xc-opportunities">{state.opportunities.map(item => <li key={item.id}><span className="xc-opportunity-icon"><WorkbenchIcon name={item.kind === 'carry' ? 'book' : 'xixi'} /></span><div><strong>{item.title}</strong><p>{item.reason}</p><small>{formatDate(item.date)}{item.start && ` · ${item.start}${item.end ? `–${item.end}` : ''}`}</small>{item.items && item.items.length > 0 && <div className="xc-tags">{item.items.map(value => <span key={value}>{value}</span>)}</div>}</div></li>)}</ul> : <p className="xc-empty">暂时没有匹配的机会<br /><span>记下想做的事，或为任务补充需要带的物品，合适时会在这里出现</span></p>}<p className="xc-footnote">候选机会以你提供的地点与设备条件为依据</p></section>}
          </GlassCardContent></section> : <div className="xc-empty" role="status"><p>{loading ? '正在读取真实事项和课表' : '还没有读取到本机数据'}</p>{!loading && <button type="button" onClick={() => { setLoading(true); void refresh().catch(reason => setError(errorText(reason))).finally(() => setLoading(false)) }}>重新读取</button>}</div>}
        </div></GlassSamplingContext.Provider>
        {error ? <footer className="xc-feedback"><span role="alert">{error}</span></footer> : <span className="p0-sr-only" aria-live="polite">{busy ? '正在处理' : notice}</span>}
      </div>
    </section></div>
  </section>
}

function GlassCardContent({ material, children }: { material: GlassMaterial; children: ReactNode }) {
  return <><MeasuredGlassSurface radius={20} material={material} /><div className="xc-glass-content">{children}</div></>
}

type Action = <T>(operation: () => Promise<T>, success: string, changed?: boolean) => Promise<T | undefined>
type WishDraft = { content: string; evidence: string; minutes: number; items: string; expiresAt: string }
const emptyWish = (): WishDraft => ({ content: '', evidence: '', minutes: 30, items: '', expiresAt: '' })

function Wishes({ wishes, busy, action }: { wishes: Wish[]; busy: boolean; action: Action }) {
  const [editing, setEditing] = useState<Wish | 'new' | null>(null)
  const [draft, setDraft] = useState<WishDraft>(emptyWish)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const content = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const edit = (wish: Wish | 'new') => {
    setEditing(wish)
    setDraft(wish === 'new' ? emptyWish() : { content: wish.content, evidence: wish.evidence, minutes: wish.minutes, items: wish.items.join('\n'), expiresAt: wish.expiresAt ? localDay(new Date(wish.expiresAt)) : '' })
    requestAnimationFrame(() => content.current?.focus({ preventScroll: true }))
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    const result = await action(() => localApi<Wish>('/companion/wish', { ...(editing && editing !== 'new' ? { id: editing.id, expectedVersion: editing.version } : {}), content: draft.content.trim(), evidence: draft.evidence.trim() || draft.content.trim(), minutes: draft.minutes, items: draft.items.split('\n').map(value => value.trim()).filter(Boolean), expiresAt: draft.expiresAt ? new Date(`${draft.expiresAt}T23:59:59`).toISOString() : null }), '这份牵挂已经记下了', true)
    if (result) { setEditing(null); setDraft(emptyWish()) }
  }
  const update = async (wish: Wish, status: 'active' | 'paused' | 'deleted') => {
    const result = await action(() => localApi('/companion/wish/update', { id: wish.id, status, expectedVersion: wish.version }), status === 'paused' ? '先放一放，想继续时再恢复' : status === 'deleted' ? '这份牵挂已移除' : '已恢复，合适的时候会重新留意', true)
    if (result && status === 'deleted') { setDeletingId(null); if (editing !== 'new' && editing?.id === wish.id) setEditing(null) }
  }
  const visible = wishes.filter(wish => wish.status !== 'deleted')
  return <section className="xc-wishes" aria-labelledby={`${id}-title`}><div className="xc-section-heading"><div><h3 id={`${id}-title`}>那些还没成为任务的小愿望</h3><p>先记在这里，有了合适的空闲再提起</p></div><button type="button" className="xc-primary" disabled={busy} onClick={() => edit('new')}>记下一件</button></div>
    {editing && <form className="xc-wish-editor" onSubmit={event => void save(event)}>
      <label htmlFor={`${id}-content`}>想做什么</label><textarea ref={content} id={`${id}-content`} rows={2} maxLength={600} required value={draft.content} onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} disabled={busy} placeholder="忙完以后，想留一点时间给……" />
      <div className="xc-form-grid"><label>大概需要多久 <span className="xc-input-unit"><input type="number" min={5} max={720} step={1} required value={draft.minutes} onChange={event => setDraft(value => ({ ...value, minutes: Number(event.target.value) }))} disabled={busy} />分钟</span></label><label>留意到哪天<input type="date" value={draft.expiresAt} onChange={event => setDraft(value => ({ ...value, expiresAt: event.target.value }))} disabled={busy} /><small>留空则持续记住</small></label></div>
      <label htmlFor={`${id}-evidence`}>背景或原话依据</label><textarea id={`${id}-evidence`} rows={2} maxLength={2000} value={draft.evidence} onChange={event => setDraft(value => ({ ...value, evidence: event.target.value }))} disabled={busy} placeholder="可选，例如上次聊到的原因；留空使用上面的原话" />
      <label htmlFor={`${id}-items`}>需要带的东西或准备条件</label><textarea id={`${id}-items`} rows={2} maxLength={6000} value={draft.items} onChange={event => setDraft(value => ({ ...value, items: event.target.value }))} disabled={busy} placeholder="每行一项，例如相机、充满电的电池" />
      <div className="xc-form-actions"><button type="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button type="submit" className="xc-primary" disabled={busy || !draft.content.trim()}>记住这件事</button></div>
    </form>}
    {visible.length ? <ul className="xc-wish-list">{visible.map(wish => <li key={wish.id} data-status={wish.status}>
      <div><strong>{wish.content}</strong>{wish.evidence !== wish.content && <p>{wish.evidence}</p>}<small>{duration(wish.minutes)}{wish.expiresAt && ` · 留意至 ${formatDate(wish.expiresAt)}`}{wish.status === 'paused' ? ' · 已暂停' : wish.status === 'expired' ? ' · 已到期' : ''}</small>{wish.items.length > 0 && <div className="xc-tags">{wish.items.map(item => <span key={item}>{item}</span>)}</div>}</div>
      <div className="xc-wish-actions"><button type="button" disabled={busy} onClick={() => edit(wish)} aria-label={`修改牵挂：${wish.content}`}><WorkbenchIcon name="settings" /><span>{wish.status === 'expired' ? '延长留意' : '修改'}</span></button>{wish.status !== 'expired' && <button type="button" disabled={busy} onClick={() => void update(wish, wish.status === 'active' ? 'paused' : 'active')}>{wish.status === 'active' ? '暂停' : '恢复'}</button>}
        {deletingId === wish.id ? <><span>移除后不可恢复</span><button type="button" disabled={busy} onClick={() => setDeletingId(null)}>保留</button><button type="button" disabled={busy} onClick={() => void update(wish, 'deleted')}>确认移除</button></> : <button type="button" disabled={busy} onClick={() => setDeletingId(wish.id)}>移除</button>}
      </div>
    </li>)}</ul> : <p className="xc-empty">还没有记下牵挂<br /><span>想学的东西、想去的地方，都可以先放在这里</span></p>}
  </section>
}

type HandoffDraft = { progress: string; obstacle: string; nextStep: string; materials: string }
const handoffDraft = (value?: Handoff | null): HandoffDraft => ({ progress: value?.progress ?? '', obstacle: value?.obstacle ?? '', nextStep: value?.nextStep ?? '', materials: value?.materials.join('\n') ?? '' })

export function TaskHandoff({ taskId, disabled = false, preview = false, embedded = false, focusRequest, onLoaded, onSaved }: {
  taskId: string; disabled?: boolean; preview?: boolean; embedded?: boolean
  focusRequest?: { field: 'progress' | 'obstacle' | 'nextStep'; revision: number } | null
  onLoaded?: (value: Handoff | null) => void; onSaved?: (value: Handoff) => void
}) {
  const id = useId()
  const root = useRef<HTMLElement>(null)
  const callbacks = useRef({ onLoaded, onSaved })
  callbacks.current = { onLoaded, onSaved }
  const [saved, setSaved] = useState<Handoff | null>(null)
  const [draft, setDraft] = useState<HandoffDraft>(handoffDraft)
  const [loading, setLoading] = useState(!preview)
  const [loaded, setLoaded] = useState(preview)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [draftWarning, setDraftWarning] = useState('')
  const savingLock = useRef(false)
  const revision = useRef(0)
  const dirty = JSON.stringify(draft) !== JSON.stringify(handoffDraft(saved))
  const latestDraft = useRef({ dirty, saved, loading })
  latestDraft.current = { dirty, saved, loading }
  const load = useCallback(async () => {
    if (preview) return
    const current = ++revision.current
    setLoading(true); setError('')
    try {
      const state = await localApi<CompanionState>('/companion')
      if (current !== revision.current) return
      const value = state.handoffs.find(item => item.taskId === taskId) ?? null
      setSaved(value)
      callbacks.current.onLoaded?.(value)
      let restored = handoffDraft(value)
      try {
        const raw = sessionStorage.getItem(`astaria-handoff-draft:${taskId}`)
        if (raw) {
          const stored = JSON.parse(raw) as HandoffDraft
          if (['progress', 'obstacle', 'nextStep', 'materials'].every(key => typeof stored[key as keyof HandoffDraft] === 'string')) {
            restored = stored
            setNotice('已恢复当前窗口未保存的接力草稿')
          }
        }
      } catch { setDraftWarning('当前窗口无法保留草稿，离开前请保存') }
      setDraft(restored)
      setLoaded(true)
    } catch (reason) { if (current === revision.current) setError(errorText(reason)) }
    finally { if (current === revision.current) setLoading(false) }
  }, [taskId, preview])
  useEffect(() => { void load(); return () => { revision.current += 1 } }, [load])
  useEffect(() => {
    if (preview || !loaded) return
    const refresh = async () => {
      if (latestDraft.current.dirty || latestDraft.current.loading || savingLock.current) return
      const current = ++revision.current
      try {
        const state = await localApi<CompanionState>('/companion')
        // A remote refresh must never replace a draft or a save started meanwhile.
        if (current !== revision.current || latestDraft.current.dirty || savingLock.current) return
        const value = state.handoffs.find(item => item.taskId === taskId) ?? null
        if (JSON.stringify(value) === JSON.stringify(latestDraft.current.saved)) return
        setSaved(value); setDraft(handoffDraft(value))
        callbacks.current.onLoaded?.(value)
      } catch { /* Preserve the visible record; explicit reload still reports failures. */ }
    }
    window.addEventListener(LOCAL_DATA_CHANGE, refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener(LOCAL_DATA_CHANGE, refresh); window.removeEventListener('focus', refresh) }
  }, [taskId, preview, loaded])
  useEffect(() => {
    if (!focusRequest || loading || disabled) return
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLTextAreaElement>(`textarea[name="${focusRequest.field}"]`)?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [focusRequest, loading, disabled])
  useEffect(() => {
    if (loading || preview || !loaded) return
    try {
      if (dirty) sessionStorage.setItem(`astaria-handoff-draft:${taskId}`, JSON.stringify(draft))
      else sessionStorage.removeItem(`astaria-handoff-draft:${taskId}`)
    } catch { setDraftWarning('当前窗口无法保留草稿，离开前请保存') }
  }, [draft, dirty, loading, loaded, preview, taskId])
  useEffect(() => {
    if (!dirty || preview) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, preview])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (savingLock.current || disabled || loading || !loaded || preview) return
    const current = revision.current
    savingLock.current = true; setSaving(true); setError(''); setNotice('')
    try {
      const value = await localApi<Handoff>('/companion/handoff', { taskId, progress: draft.progress.trim(), obstacle: draft.obstacle.trim(), nextStep: draft.nextStep.trim(), materials: draft.materials.split('\n').map(item => item.trim()).filter(Boolean), expectedVersion: saved?.version ?? 0 })
      notifyLocalDataChange()
      if (current !== revision.current) return
      setSaved(value); setDraft(handoffDraft(value)); setNotice('接力现场已保存，下次从这里继续')
      callbacks.current.onSaved?.(value)
    } catch (reason) { if (current === revision.current) setError(errorText(reason)) }
    finally { savingLock.current = false; if (current === revision.current) setSaving(false) }
  }
  const field = (key: keyof HandoffDraft, label: string, placeholder: string, rows = 2): ReactNode => <label htmlFor={`${id}-${key}`}><span>{label}</span><textarea id={`${id}-${key}`} name={key} value={draft[key]} maxLength={key === 'materials' ? 6000 : 1500} rows={rows} placeholder={placeholder} onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, [key]: value })); setNotice('') }} disabled={disabled || loading || saving || preview} /></label>
  return <section ref={root} className="xc-handoff" data-embedded={embedded} aria-labelledby={`${id}-title`}><header><div><h3 id={`${id}-title`} className={embedded ? 'p0-sr-only' : undefined}>给下一次，留个接力现场</h3><p>{saved ? `上次保存 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(saved.updatedAt))}` : '做到哪、卡在哪，下次打开就能接着做'}</p></div>{!embedded && <WorkbenchIcon name="book" />}</header>{loading ? <p role="status">正在恢复接力现场</p> : <form onSubmit={event => void save(event)}><div className="xc-handoff-grid">{field('progress', '已经做到', '给未来的自己留一句进度')}{field('nextStep', '下一步', '回来后先做哪一小步')}{field('obstacle', '卡住的地方', '可选，析熙会一起记着')}{field('materials', '相关材料', '文件名、链接或准备物品，每行一项')}</div><footer><span>{preview ? '示例不保存接力记录' : draftWarning || (dirty ? '修改尚未保存 · 当前窗口已保留草稿' : notice || '接力记录会提供给析熙，帮助你继续当前事项')}</span><button type="submit" disabled={disabled || loading || !loaded || saving || preview || !dirty}>{saving ? '正在保存' : '保存接力'}<WorkbenchIcon name="check" /></button></footer></form>}{error && <p className="xc-handoff-error" role="alert">{error}<button type="button" disabled={saving || disabled} onClick={() => void load()}>重新读取</button></p>}</section>
}
