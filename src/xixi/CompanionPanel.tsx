import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, ReactNode } from 'react'
import type { Task } from '../domain/task'
import { localDay } from '../home/agenda'
import { GlassSamplingContext } from '../home/GlassSurface'
import { WorkspaceHeading } from '../ui/WorkspaceHeading'
import type { GlassMaterial } from '../home/GlassSurface'
import { WorkbenchIcon } from '../workbench/WorkbenchIcon'
import { LOCAL_DATA_CHANGE, notifyLocalDataChange } from '../stores/migration'
import { usePlanner } from '../planner/usePlanner'
import { localApi } from './api'
import { usePreferences } from './preferences'
import { DecisionStudio } from './DecisionStudio'
import { beginDecisionExit, DECISION_CONTENT_EXIT_MS, DECISION_ENTER_MS, DECISION_EXIT_MS, DECISION_REVEAL_MS, getDecisionEffect, setDecisionEffect } from '../prototype/decisionEffect'
import type { CompanionState, Handoff } from './companionTypes'
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
  covered?: boolean
  onExited?: () => void
  onRevealDestination?: () => void
}
const GLASS_RELEASE_MS = 240
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '暂时没有完成，请重试'

export function CompanionPanel({ tasks, tasksLoading, tasksError, onChanged, onNotice, initialScenarioId, exiting = false, covered = false, onExited, onRevealDestination }: Props) {
  const preferences = usePreferences().value
  const planner = usePlanner(true)
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const [sampling, setSampling] = useState(true)
  const leaving = exiting
  const departure = useRef({ onExited, onRevealDestination })
  departure.current = { onExited, onRevealDestination }
  const reducedMotion = preferences.effect.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches
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
  useEffect(() => {
    if (!leaving) {
      setSampling(true)
      const current = getDecisionEffect()
      if (current.active) setDecisionEffect(current)
      return
    }
    beginDecisionExit()
    // Fade the optical layer before releasing it; removing it on the first
    // frame makes the glass edge pop even when the rest of the pane fades.
    const release = setTimeout(() => setSampling(false), reducedMotion || document.hidden ? 0 : GLASS_RELEASE_MS)
    const finish = () => departure.current.onExited?.()
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
  return <section className="xc-page" data-studio="true" data-leaving={leaving} data-exiting={exiting} data-covered={covered} data-spatial="false" data-theme={preferences.theme} data-grid={preferences.grid} data-motion={preferences.effect.motion} style={{ '--decision-enter-duration': `${DECISION_ENTER_MS}ms`, '--decision-exit-duration': `${DECISION_EXIT_MS}ms`, '--decision-reveal-duration': `${DECISION_REVEAL_MS}ms`, '--decision-glass-release': `${GLASS_RELEASE_MS}ms`, '--decision-content-duration': `${(exiting ? DECISION_CONTENT_EXIT_MS : DECISION_EXIT_MS) - GLASS_RELEASE_MS}ms` } as CSSProperties} inert={exiting} aria-hidden={exiting} aria-label="平行宇宙">
    <div className="xc-page-background" aria-hidden="true" />
    <div className="xc-page-scroll workspace-page-viewport"><section className="xc-dialog workspace-page-container" data-spatial="false" aria-labelledby={`${id}-title`}>
      <div className="xc-shell">
        <WorkspaceHeading className="xc-header" copyClassName="xc-heading" title="平行宇宙" titleId={`${id}-title`} headingRef={heading} />
        <GlassSamplingContext.Provider value={sampling}><div className="xc-scroll" inert={leaving}>
          {state ? <DecisionStudio exiting={leaving} tasks={tasks} tasksLoading={tasksLoading} tasksError={tasksError} state={state} date={date} onDate={setDate} plannerRevision={planner.state?.revision} plannerLoading={planner.loading} plannerError={planner.error} loading={loading} busy={busy} action={action} material={material} initialScenarioId={initialScenarioId} /> : <div className="xc-empty" role="status"><p>{loading ? '正在读取真实事项和课表' : '还没有读取到本机数据'}</p>{!loading && <button type="button" onClick={() => { setLoading(true); void refresh().catch(reason => setError(errorText(reason))).finally(() => setLoading(false)) }}>重新读取</button>}</div>}
        </div></GlassSamplingContext.Provider>
        {error ? <footer className="xc-feedback"><span role="alert">{error}</span></footer> : <span className="p0-sr-only" aria-live="polite">{busy ? '正在处理' : notice}</span>}
      </div>
    </section></div>
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
