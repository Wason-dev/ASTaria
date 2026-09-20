import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { agendaDate, localDay } from '../home/agenda'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { GlassMaterial } from '../home/GlassSurface'
import { WorkbenchIcon } from '../workbench/WorkbenchIcon'
import { notifyLocalDataChange } from '../stores/migration'
import { sceneProjection } from '../spatial/scene'
import type { SceneCamera } from '../spatial/scene'
import { useSceneCamera } from '../spatial/useSceneCamera'
import { localApi } from './api'
import { usePreferences } from './preferences'
import type { CompanionDay, CompanionMode, CompanionScenario, CompanionState, Handoff, Wish } from './companionTypes'
import './companion.css'

type Props = {
  onChanged: () => void | Promise<void>
  onNotice: (message: string) => void
  initialMode?: CompanionMode
  readCamera?: () => SceneCamera | undefined
  initialTab?: Tab
  initialScenarioId?: string
}
type Tab = 'scenarios' | 'wishes' | 'opportunities'
const MODES: Array<{ id: CompanionMode; label: string; description: string }> = [
  { id: 'rebalance', label: '重新梳理', description: '按截止时间，找合适的空闲' },
  { id: 'rest', label: '这天休息', description: '从明天开始，看看安排怎么变' },
  { id: 'light', label: '轻一点', description: '拆成短段，留出缓冲和休息' },
]
const TABS: Array<{ id: Tab; label: string }> = [{ id: 'scenarios', label: '平行宇宙' }, { id: 'wishes', label: '牵挂清单' }, { id: 'opportunities', label: '合适的时机' }]
const STATE_LABEL = { preview: '尚未应用', applied: '已应用', discarded: '已放下', undone: '已撤销' }
const formatDate = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(agendaDate(value) ?? new Date())
const duration = (value: number) => {
  const minutes = Math.max(0, Math.floor(value))
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}` : `${minutes} 分钟`
}
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '暂时没有完成，请重试'

export function CompanionPanel({ onChanged, onNotice, initialMode = 'rebalance', readCamera, initialTab = 'scenarios', initialScenarioId }: Props) {
  const preferences = usePreferences().value
  const id = useId()
  const dialog = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [date, setDate] = useState(() => localDay(new Date()))
  const [state, setState] = useState<CompanionState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const actionLock = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<CompanionMode>(initialMode)
  const [budgetMin, setBudgetMin] = useState(60)
  const [selectedId, setSelectedId] = useState<string | null>(initialScenarioId ?? null)
  const initialTarget = useRef(initialScenarioId)
  const [dayIndex, setDayIndex] = useState(0)
  const [spatial, setSpatial] = useState(false)
  const [wide, setWide] = useState(() => innerWidth >= 1000)
  const [focusedTask, setFocusedTask] = useState<string | null>(null)
  const loadRevision = useRef(0)
  const selected = state?.scenarios.find(item => item.id === selectedId) ?? null

  const refresh = useCallback(async () => {
    const revision = ++loadRevision.current
    const next = await localApi<CompanionState>(`/companion?date=${encodeURIComponent(date)}&days=7`)
    if (revision === loadRevision.current) setState(next)
  }, [date])
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
    return () => {
      loadRevision.current += 1
    }
  }, [])
  useEffect(() => {
    setTab(initialTab)
    initialTarget.current = initialScenarioId
    if (initialScenarioId) setSelectedId(initialScenarioId)
  }, [initialTab, initialScenarioId])
  useEffect(() => {
    const query = matchMedia('(min-width:1000px)')
    const update = () => setWide(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!initialTarget.current || !state) return
    const target = state.scenarios.find(item => item.id === initialTarget.current)
    initialTarget.current = undefined
    if (target) { setSelectedId(target.id); setDate(target.date) }
    else setNotice('这份方案已不在当前记录中，可以重新推演')
  }, [state, initialScenarioId])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setState(null); setDayIndex(0)
    void refresh().catch(reason => { if (!cancelled) setError(errorText(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; loadRevision.current += 1 }
  }, [refresh])
  const action = async <T,>(operation: () => Promise<T>, success: string, changed = false): Promise<T | undefined> => {
    if (actionLock.current) return undefined
    actionLock.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await operation()
      setNotice(success); onNotice(success)
      if (changed) notifyLocalDataChange()
      try { await refresh(); if (changed) await onChanged() }
      catch (reason) { setError(`操作已保存，但页面尚未同步：${errorText(reason)}`) }
      return result
    } catch (reason) { setError(errorText(reason)); return undefined }
    finally { actionLock.current = false; setBusy(false) }
  }
  const createScenario = async () => {
    const result = await action(() => localApi<CompanionScenario>('/companion/scenario', { date, days: 7, mode, ...(mode === 'light' ? { budgetMin } : {}) }), '方案已生成，查看变化后再决定')
    if (result) { setSelectedId(result.id); setDayIndex(0) }
  }
  const chooseScenario = (value: string) => {
    setSelectedId(value || null)
    const candidate = state?.scenarios.find(item => item.id === value)
    if (candidate && candidate.date !== date) setDate(candidate.date)
  }
  const day = state?.timeline?.[dayIndex]
  const shownScenario = selected?.date === date ? selected : null
  const spaceOpen = spatial && wide && tab === 'scenarios' && Boolean(day)
  const selectSpatialTask = (taskId: string) => {
    setFocusedTask(taskId)
    requestAnimationFrame(() => {
      const row = dialog.current?.querySelector<HTMLElement>(`[data-lens-task="${CSS.escape(taskId)}"]`)
      row?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      row?.focus({ preventScroll: true })
    })
  }
  const dateControls = <div className="xc-date-row"><label htmlFor={`${id}-date`}>从哪天看起</label><input id={`${id}-date`} type="date" value={date} disabled={busy} onChange={event => { if (event.target.value) { setDate(event.target.value); setSelectedId(null) } }} /><span>接下来 7 天</span><button type="button" className="xc-text-button" disabled={busy || loading} onClick={() => { const today = localDay(new Date()); setDate(today); setSelectedId(null); if (today === date) void refresh().catch(reason => setError(errorText(reason))) }}>回到今天</button></div>

  const material: GlassMaterial | null = spaceOpen ? null : { transmission: 70, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }

  return <section className="xc-page" data-spatial={spaceOpen} data-theme={preferences.theme} data-grid={preferences.grid} data-motion={preferences.effect.motion} aria-label="平行宇宙" onKeyDown={event => { if (spaceOpen && event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); setSpatial(false); requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>('.xc-space-toggle')?.focus({ preventScroll: true })) } }}>
    <div className="xc-page-background" aria-hidden="true" />
    <div className="xc-page-scroll"><section ref={dialog} className="xc-dialog" data-spatial={spaceOpen} aria-labelledby={`${id}-title`}>
      {spaceOpen && <MeasuredGlassSurface radius={24} material={{ transmission: 70, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }} />}
      <div className="xc-shell">
        <header className="xc-header"><div className="xc-heading"><span className="xc-eyebrow">与析熙一起</span><h2 id={`${id}-title`} tabIndex={-1} ref={heading}>平行宇宙</h2></div><nav className="xc-tabs" aria-label="析熙探索分区">{TABS.map(item => <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}{item.id === 'wishes' && state && <small>{state.wishes.filter(wish => wish.status === 'active').length}</small>}</button>)}</nav></header>
        <div className="xc-scroll">
          {loading ? <p className="xc-empty" role="status">正在读取真实事项和课表</p> : state ? <div key={tab} className="xc-tab-content">
            {tab === 'scenarios' && <div className="xc-scenario-layout">
              <section aria-label="选择推演方式" className="xc-scenario-start xc-glass"><GlassCardContent material={material}><div className="xc-control-heading"><h3>如果换一种安排</h3></div><div className="xc-modes">{MODES.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} disabled={busy} onClick={() => setMode(item.id)}><strong>{item.label}</strong><span>{item.description}</span></button>)}</div>
                {dateControls}
                <div className="xc-scenario-actions">{mode === 'light' ? <label className="xc-budget">每天最多安排 <input type="number" min={15} max={480} step={15} value={budgetMin} onChange={event => setBudgetMin(Math.max(15, Math.min(480, Number(event.target.value) || 15)))} disabled={busy} /> 分钟</label> : <p>结合课表、预计用时和截止时间</p>}<button className="xc-primary" type="button" disabled={busy || loading} onClick={() => void createScenario()}>{busy ? '正在处理' : '看看会怎样'}<WorkbenchIcon name="arrow" /></button></div>
              </GlassCardContent></section>
              <section className="xc-lens" aria-labelledby={`${id}-lens`}>
                <div className="xc-overview xc-glass"><GlassCardContent material={material}><div className="xc-section-heading"><div><h3 id={`${id}-lens`}>时间透镜</h3>{shownScenario ? <div className="xc-scenario-status"><span data-status={shownScenario.status}>{STATE_LABEL[shownScenario.status]}</span><small>查看变化后再决定</small></div> : <p>原安排与候选方案，放在一起看</p>}</div><label className="xc-history"><span className="p0-sr-only">选择已保存方案</span><select aria-label="选择已保存方案" value={selectedId ?? ''} onChange={event => chooseScenario(event.target.value)} disabled={busy}><option value="">当前安排</option>{state.scenarios.map(item => <option key={item.id} value={item.id}>{formatDate(item.date)} · {MODES.find(value => value.id === item.mode)?.label} · {STATE_LABEL[item.status]}</option>)}</select></label>{wide && <button type="button" className="xc-space-toggle" aria-pressed={spaceOpen} onClick={() => setSpatial(value => !value)}><WorkbenchIcon name="xixi" />{spaceOpen ? '返回完整时间线' : '在黑洞上预演'}</button>}</div>
                <div className="xc-day-selector" role="group" aria-label="时间透镜日期">{state.timeline.map((item, index) => <button type="button" key={item.date} aria-pressed={index === dayIndex} onClick={() => setDayIndex(index)}><span>{index === 0 ? formatDate(item.date) : formatDate(item.date).replace(/^\d+\//, '')}</span><small>{item.deadlines.length ? `${item.deadlines.length} 项截止` : `空闲 ${duration(item.freeMin)}`}</small></button>)}</div>
                {state.timeline.length > 1 && <label className="xc-timeline-range"><span className="p0-sr-only">移动日期查看安排</span><input type="range" min={0} max={state.timeline.length - 1} step={1} value={dayIndex} aria-label="时间透镜日期滑条" aria-valuetext={day ? formatDate(day.date) : ''} onChange={event => setDayIndex(Number(event.target.value))} /></label>}
                </GlassCardContent></div>
                {day ? <DayComparison key={`${day.date}-${shownScenario?.id ?? ''}`} day={day} scenario={shownScenario} focusedTask={focusedTask} material={material} /> : <p className="xc-empty">还没有可查看的时间信息</p>}
                {shownScenario && <ScenarioResult scenario={shownScenario} busy={busy} onApply={() => void action(() => localApi('/companion/scenario/apply', { id: shownScenario.id, expectedVersion: shownScenario.version }), '安排已更新，日程已同步', true)} onDiscard={() => void action(() => localApi('/companion/scenario/discard', { id: shownScenario.id, expectedVersion: shownScenario.version }), '这份方案已放下，原安排保持原样')} onUndo={() => void action(() => localApi(`/operations/${encodeURIComponent(shownScenario.operationId!)}/undo`, {}), '已撤销这次调整，原安排已恢复', true)} />}
              </section>
            </div>}
            {tab !== 'scenarios' && <section className="xc-auxiliary xc-glass"><GlassCardContent material={material}>{dateControls}
            {tab === 'wishes' && <Wishes wishes={state.wishes} busy={busy} action={action} />}
            {tab === 'opportunities' && <section aria-label="根据真实条件找到的机会"><div className="xc-section-heading"><div><h3>条件刚好合适</h3><p>来自可用时段、已记录的牵挂和任务准备物品</p></div></div>{state.opportunities.length ? <ul className="xc-opportunities">{state.opportunities.map(item => <li key={item.id}><span className="xc-opportunity-icon"><WorkbenchIcon name={item.kind === 'carry' ? 'book' : 'xixi'} /></span><div><strong>{item.title}</strong><p>{item.reason}</p><small>{formatDate(item.date)}{item.start && ` · ${item.start}${item.end ? `–${item.end}` : ''}`}</small>{item.items && item.items.length > 0 && <div className="xc-tags">{item.items.map(value => <span key={value}>{value}</span>)}</div>}</div></li>)}</ul> : <p className="xc-empty">暂时没有匹配的机会<br /><span>记下想做的事，或为任务补充需要带的物品，合适时会在这里出现</span></p>}<p className="xc-footnote">这里展示候选机会，不会自行占用时间；地点与设备状态以你提供的信息为准</p></section>}
            </GlassCardContent></section>}
          </div> : <div className="xc-empty"><p>还没有读取到本机数据</p><button type="button" onClick={() => { setLoading(true); void refresh().catch(reason => setError(errorText(reason))).finally(() => setLoading(false)) }}>重新读取</button></div>}
        </div>
        {error ? <footer className="xc-feedback"><span role="alert">{error}</span></footer> : <span className="p0-sr-only" aria-live="polite">{busy ? '正在处理' : notice}</span>}
      </div>
      {spaceOpen && day && <SpatialLens day={day} scenario={shownScenario} readCamera={readCamera} selectedTask={focusedTask} onSelect={selectSpatialTask} />}
    </section></div>
    </section>

}

function GlassCardContent({ material, children }: { material: GlassMaterial | null; children: ReactNode }) {
  return material ? <><MeasuredGlassSurface radius={20} material={material} /><div className="xc-glass-content">{children}</div></> : <>{children}</>
}

function DayComparison({ day, scenario, focusedTask, material }: { day: CompanionDay; scenario: CompanionScenario | null; focusedTask: string | null; material: GlassMaterial | null }) {
  const existing = day.blocks.filter(block => block.kind !== 'available').sort((a, b) => a.start.localeCompare(b.start))
  const candidate = scenario ? [...existing.filter(block => !scenario.removedBlockIds.includes(block.id)), ...scenario.plans.filter(plan => plan.date === day.date).map(plan => ({ ...plan, kind: 'task' as const }))].sort((a, b) => a.start.localeCompare(b.start)) : []
  const column = (title: string, blocks: typeof existing, proposed = false) => <div className="xc-day-column xc-glass" data-proposed={proposed}><GlassCardContent material={material}><h4>{title}</h4>{blocks.length ? <ol>{blocks.map(block => <li key={block.id} data-kind={block.kind} data-lens-task={block.taskId} data-selected={Boolean(block.taskId && block.taskId === focusedTask)} tabIndex={block.taskId ? -1 : undefined}><time>{block.start}<span>–{block.end}</span></time><span>{block.title}{block.kind === 'class' && <small>课程</small>}{block.kind === 'break' && <small>休息</small>}</span></li>)}</ol> : <p className="xc-empty">这一天尚未安排</p>}</GlassCardContent></div>
  return <div className="xc-day-content"><div className="xc-day-metrics"><strong>{formatDate(day.date)}</strong><span>可支配 {duration(day.availableMin)}</span><span>尚余 {duration(day.remainingMin ?? day.freeMin)}</span></div><div className="xc-comparison" data-comparing={Boolean(scenario)}>{column(scenario?.status === 'applied' ? '目前已应用的安排' : '当前安排', existing)}{scenario && scenario.status === 'preview' && column('如果这样安排', candidate, true)}</div>{day.deadlines.length > 0 && <div className="xc-deadlines"><span>这天截止</span>{day.deadlines.map(item => <div key={item.taskId} data-lens-task={item.taskId} data-selected={item.taskId === focusedTask} tabIndex={-1}><strong>{item.title}</strong><small>{item.due.length > 10 ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(agendaDate(item.due)) : '当天'}</small></div>)}</div>}</div>
}

const noCamera = () => undefined
function SpatialLens({ day, scenario, readCamera, selectedTask, onSelect }: { day: CompanionDay; scenario: CompanionScenario | null; readCamera?: () => SceneCamera | undefined; selectedTask: string | null; onSelect: (taskId: string) => void }) {
  const camera = useSceneCamera(readCamera ?? noCamera, day.date)
  const [viewport, setViewport] = useState(() => ({ width: innerWidth, height: innerHeight }))
  useEffect(() => {
    const update = () => setViewport({ width: innerWidth, height: innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  const projection = sceneProjection(camera, viewport.width, viewport.height)
  const items = new Map<string, { taskId: string; title: string; current: string[]; proposed: string[]; due?: string }>()
  const get = (taskId: string, title: string) => {
    if (!items.has(taskId)) items.set(taskId, { taskId, title, current: [], proposed: [] })
    return items.get(taskId)!
  }
  for (const block of day.blocks) if (block.kind === 'task' && block.taskId) get(block.taskId, block.title).current.push(`${block.start}–${block.end}`)
  if (scenario?.status === 'preview') for (const plan of scenario.plans.filter(item => item.date === day.date)) get(plan.taskId, plan.title).proposed.push(`${plan.start}–${plan.end}`)
  for (const due of day.deadlines) get(due.taskId, due.title).due = due.due
  const visible = [...items.values()].slice(0, 6)
  const left = 474, right = viewport.width - 240, top = 190, bottom = viewport.height - 90
  const radius = Math.min(viewport.height * .3, (viewport.width - left) * .55)
  const orbit = Array.from({ length: 61 }, (_, index) => {
    const point = projection.point(radius / projection.unit, (70 + index * 220 / 60) * Math.PI / 180)
    return `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`
  }).join(' ')
  return <section className="xc-space" data-date={day.date} aria-label={`${formatDate(day.date)}的黑洞空间预演`}>
    <header><span>时间透镜 · 空间预演</span><h3>{formatDate(day.date)}</h3><p>浅银是当前安排，暖金是候选，截止用菱形标记</p></header>
    <svg className="xc-space-orbit" viewBox={`0 0 ${viewport.width} ${viewport.height}`} aria-hidden="true"><path d={orbit} /></svg>
    {visible.length ? visible.map((item, index) => {
      const angle = (105 + index * 150 / Math.max(1, visible.length - 1)) * Math.PI / 180
      const point = projection.point(radius / projection.unit, angle)
      const x = Math.max(left + 80, Math.min(right, point.x))
      const y = top + (index + 1) * (bottom - top) / (visible.length + 1)
      const proposed = item.proposed.length > 0
      return <button type="button" key={`${day.date}-${item.taskId}`} className="xc-space-node" data-candidate={proposed} data-selected={selectedTask === item.taskId} data-task-id={item.taskId} style={{ left: x, top: y }} onClick={() => onSelect(item.taskId)} aria-label={`${item.title}，${proposed ? `候选 ${item.proposed.join('、')}` : item.current.length ? `当前 ${item.current.join('、')}` : '当天截止'}，查看时间线`}><i aria-hidden="true" /><span><strong>{item.title}</strong>{item.current.length > 0 && <small>当前 {item.current.join(' · ')}</small>}{proposed && <small className="xc-space-candidate">候选 {item.proposed.join(' · ')}</small>}{item.due && <small>◇ 当天截止</small>}</span></button>
    }) : <p className="xc-space-empty">这一天没有已排事项或截止节点<br /><span>移动左侧日期滑条，看看接下来的日子</span></p>}
    <footer>{items.size > 6 ? `还有 ${items.size - 6} 项，完整内容在左侧时间线` : '点击节点，回到对应事项的时间与细节'}<span>节点是可读索引，位置不代表物理距离或紧急程度</span></footer>
  </section>
}

function ScenarioResult({ scenario, busy, onApply, onDiscard, onUndo }: { scenario: CompanionScenario; busy: boolean; onApply: () => void; onDiscard: () => void; onUndo: () => void }) {
  const changes = scenario.plans.length + scenario.removedBlockIds.length
  return <div className="xc-scenario-result">
    {scenario.metrics && <p className="xc-result-metrics">计划用时 {duration(scenario.metrics.scheduledMin)}<span>待安排 {duration(scenario.metrics.unscheduledMin)}</span></p>}
    {scenario.warnings.length > 0 && <ul className="xc-warnings">{scenario.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul>}
    {scenario.unscheduled.length > 0 && <div className="xc-unscheduled"><h4>这些还需要你和析熙商量</h4><ul>{scenario.unscheduled.map(item => <li key={item.taskId}><strong>{item.title}</strong><span>{item.reason}{item.remainingMin > 0 && ` · 剩余 ${duration(item.remainingMin)}`}</span></li>)}</ul></div>}
    <div className="xc-apply-row">{scenario.status === 'preview' ? <><p>{changes ? `${scenario.plans.length} 个时段将被安排，${scenario.removedBlockIds.length} 个原时段将被替换` : '没有需要调整的时段'}</p><button type="button" disabled={busy} onClick={onDiscard}>放下方案</button><button type="button" className="xc-primary" disabled={busy || !changes} onClick={onApply}>就这样安排<WorkbenchIcon name="check" /></button></> : scenario.status === 'applied' && scenario.operationId ? <><p>安排已保存，打开日历和时间表就能看到</p><button type="button" disabled={busy} onClick={onUndo}><WorkbenchIcon name="undo" />撤销这次调整</button></> : <p>这份方案已{scenario.status === 'undone' ? '撤销' : '放下'}，可以重新推演</p>}</div>
  </div>
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

export function TaskHandoff({ taskId, disabled = false, preview = false }: { taskId: string; disabled?: boolean; preview?: boolean }) {
  const id = useId()
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
  const load = useCallback(async () => {
    if (preview) return
    const current = ++revision.current
    setLoading(true); setError('')
    try {
      const state = await localApi<CompanionState>('/companion')
      if (current !== revision.current) return
      const value = state.handoffs.find(item => item.taskId === taskId) ?? null
      setSaved(value)
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
    if (savingLock.current || preview) return
    savingLock.current = true; setSaving(true); setError(''); setNotice('')
    try {
      const value = await localApi<Handoff>('/companion/handoff', { taskId, progress: draft.progress.trim(), obstacle: draft.obstacle.trim(), nextStep: draft.nextStep.trim(), materials: draft.materials.split('\n').map(item => item.trim()).filter(Boolean), expectedVersion: saved?.version ?? 0 })
      setSaved(value); setDraft(handoffDraft(value)); setNotice('接力现场已保存，下次从这里继续')
      notifyLocalDataChange()
    } catch (reason) { setError(errorText(reason)) }
    finally { savingLock.current = false; setSaving(false) }
  }
  const field = (key: keyof HandoffDraft, label: string, placeholder: string, rows = 2): ReactNode => <label htmlFor={`${id}-${key}`}><span>{label}</span><textarea id={`${id}-${key}`} value={draft[key]} maxLength={key === 'materials' ? 6000 : 1500} rows={rows} placeholder={placeholder} onChange={event => { const value = event.target.value; setDraft(current => ({ ...current, [key]: value })); setNotice('') }} disabled={disabled || loading || saving || preview} /></label>
  return <section className="xc-handoff" aria-labelledby={`${id}-title`}><header><div><h3 id={`${id}-title`}>给下一次，留个接力现场</h3><p>{saved ? `上次保存 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(saved.updatedAt))}` : '做到哪、卡在哪，下次打开就能接着做'}</p></div><WorkbenchIcon name="book" /></header>{loading ? <p role="status">正在恢复接力现场</p> : <form onSubmit={event => void save(event)}><div className="xc-handoff-grid">{field('progress', '已经做到', '给未来的自己留一句进度')}{field('nextStep', '下一步', '回来后先做哪一小步')}{field('obstacle', '卡住的地方', '可选，析熙会一起记着')}{field('materials', '相关材料', '文件名、链接或准备物品，每行一项')}</div><footer><span>{preview ? '示例不保存接力记录' : draftWarning || (dirty ? '修改尚未保存 · 当前窗口已保留草稿' : notice || '接力记录会提供给析熙，帮助你继续当前事项')}</span><button type="submit" disabled={disabled || saving || preview || !dirty}>{saving ? '正在保存' : '保存接力'}<WorkbenchIcon name="check" /></button></footer></form>}{error && <p className="xc-handoff-error" role="alert">{error}<button type="button" disabled={saving || disabled} onClick={() => void load()}>重新读取</button></p>}</section>
}
