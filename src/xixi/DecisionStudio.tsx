import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Task } from '../domain/task'
import { agendaDate, localDay, shiftDay } from '../home/agenda'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { GlassMaterial } from '../home/GlassSurface'
import { setDecisionEffect } from '../prototype/decisionEffect'
import { localApi } from './api'
import type { CompanionScenario, CompanionState, RouteHorizon, ScenarioPlan } from './companionTypes'
import './route-comparison.css'

type Action = <T>(operation: () => Promise<T>, success: string, changed?: boolean) => Promise<T | undefined>
type Props = {
  tasks: Task[]; tasksLoading: boolean; tasksError: string; state: CompanionState
  date: string; onDate: (value: string) => void; plannerRevision?: number
  plannerLoading: boolean; plannerError: string; loading: boolean; busy: boolean
  action: Action; material: GlassMaterial; initialScenarioId?: string; exiting?: boolean
}
const HORIZONS: Array<{id: RouteHorizon; label: string}> = [{ id: 'week', label: '这周' }, { id: 'fourWeeks', label: '四周' }, { id: 'threeMonths', label: '三个月' }, { id: 'oneYear', label: '一年' }]
const STATUS = { preview: '尚未采用', applied: '已采用', undone: '已撤销', discarded: '已放下' }
const dayLabel = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(agendaDate(value) ?? new Date())
const sameTime = (a: ScenarioPlan, b: ScenarioPlan) => a.taskId === b.taskId && a.date === b.date && a.start === b.start && a.end === b.end
function Plate({ children, material, className = '' }: {children: ReactNode; material: GlassMaterial; className?: string}) {
  return <section className={`xc-glass route-plate ${className}`}><MeasuredGlassSurface radius={20} material={material} /><div className="xc-glass-content">{children}</div></section>
}
function Notes({title, values}: {title: string; values: string[]}) {
  return values.length ? <section className="route-notes"><h4>{title}</h4><ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul></section> : null
}

export function DecisionStudio({ tasks, tasksLoading, tasksError, state, date, onDate, plannerRevision, plannerLoading, plannerError, loading, busy, action, material, initialScenarioId, exiting = false }: Props) {
  const id = useId()
  const available = useMemo(() => tasks.filter(task => !task.deletedAt && !task.freeTimeGoalId && ['todo', 'doing'].includes(task.status)), [tasks])
  const [taskId, setTaskId] = useState('')
  const [question, setQuestion] = useState('')
  const [recurrence, setRecurrence] = useState<'once' | 'weekly'>('once')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [horizon, setHorizon] = useState<RouteHorizon>('week')
  const [detail, setDetail] = useState<'judgment' | 'facts' | 'observe'>('judgment')
  const [dayIndex, setDayIndex] = useState(0)
  const targetRef = useRef<string | undefined>(undefined)
  const selected = state.scenarios.find(value => value.id === selectedId)
  const analysis = selected?.routeAnalysis
  const subject = tasks.find(task => task.id === taskId)
  const restore = (value: CompanionScenario) => {
    setSelectedId(value.id); onDate(value.date); setDayIndex(0)
    setTaskId(value.routeAnalysis?.facts.task.id ?? value.decision?.taskId ?? '')
    setQuestion(value.routeAnalysis?.question ?? '')
    setRecurrence(value.decision?.recurrence ?? 'once')
  }
  useEffect(() => {
    // Receipt restoration owns the subject while its saved target is loading.
    // StrictMode may replay this effect before the restore state is committed.
    if (!selectedId && !initialScenarioId && !available.some(task => task.id === taskId)) setTaskId(available[0]?.id ?? '')
  }, [available, taskId, selectedId, initialScenarioId])
  useEffect(() => {
    if (initialScenarioId && initialScenarioId !== targetRef.current) {
      const value = state.scenarios.find(item => item.id === initialScenarioId)
      if (value) { targetRef.current = initialScenarioId; restore(value) }
    }
  }, [initialScenarioId, state.scenarios])
  // Keep the existing optical transition; this iteration changes the information layout only.
  useEffect(() => {
    if (!exiting) setDecisionEffect({ active: true, horizon: 0, branch: 0, comparing: false, emphasis: .5 })
  }, [exiting])
  useEffect(() => () => { setDecisionEffect({ active: false }) }, [])
  const invalidate = () => setSelectedId(null)
  const stale = selected?.status === 'preview' && (selected.baseRevision !== plannerRevision ||
    Object.keys(selected.taskVersions).length !== tasks.length || Object.entries(selected.taskVersions).some(([key, version]) => tasks.find(task => task.id === key)?.updatedAt !== version))
  const blocked = busy || loading || tasksLoading || plannerLoading || Boolean(tasksError || plannerError)
  const create = async () => {
    if (blocked || !taskId || !question.trim()) return
    const value = await action(() => localApi<CompanionScenario>('/companion/route', { taskId, date, question: question.trim(), recurrence }), '析熙的两条路线已保存，日历尚未改变')
    if (value) { setSelectedId(value.id); setDetail('judgment'); setDayIndex(0) }
  }
  const baseline = analysis?.facts.baseline ?? selected?.decision?.baseline ?? []
  const candidate = analysis?.facts.candidate ?? selected?.plans ?? []
  const dates = Array.from({length: 7}, (_, index) => localDay(shiftDay(agendaDate(date) ?? new Date(), index)))
  const chosenDate = dates[dayIndex]
  const day = (analysis?.facts.timeline ?? state.timeline).find(item => item.date === chosenDate)
  const trend = analysis?.trends[horizon]
  const comparisonExists = Boolean(selected)
  const legacy = Boolean(selected && !selected.decision && !analysis)
  const canApply = selected?.status === 'preview' && !stale && selected.plans.length + selected.removedBlockIds.length > 0
  const held = baseline.filter(block => !selected?.removedBlockIds.includes(block.id))
  const after = [...held, ...candidate.filter(block => !held.some(old => sameTime(old, block)))]
  return <div className="route-studio">
    <Plate material={material} className="route-choice">
      <div className="route-choice-top"><label>正在考虑的事<select aria-label="选择推演事项" value={taskId} disabled={busy || tasksLoading} onChange={event => {setTaskId(event.target.value); invalidate()}}><option value="">选择一件具体的事</option>{selected && subject && !available.some(task => task.id === subject.id) && <option value={subject.id}>{subject.title} · 已结束</option>}{available.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <label>从哪天开始<input aria-label="推演起始日期" type="date" min={localDay(new Date())} value={date} disabled={busy} onChange={event => {if(event.target.value) {onDate(event.target.value); invalidate(); setDayIndex(0)}}} /></label>
        <label>已保存的比较<select aria-label="选择已保存推演" value={selectedId ?? ''} disabled={busy} onChange={event => { const value = state.scenarios.find(item => item.id === event.target.value); if(value) restore(value); else invalidate() }}><option value="">新的选择</option>{[...state.scenarios].reverse().map(item => <option key={item.id} value={item.id}>{item.routeAnalysis?.facts.task.title ?? item.decision?.title ?? '历史方案'} · {STATUS[item.status]}</option>)}</select></label>
      </div>
      <form className="route-question" onSubmit={event => {event.preventDefault(); void create()}}><label className="p0-sr-only" htmlFor={`${id}-question`}>你想比较的选择</label><input id={`${id}-question`} maxLength={1000} value={question} disabled={busy} onChange={event => {setQuestion(event.target.value); invalidate()}} placeholder="例如：今天先休息，把这件事移到明天，会挤掉什么？" />
        <label className="route-repeat"><input type="checkbox" checked={recurrence === 'weekly'} disabled={busy} onChange={event => {setRecurrence(event.target.checked ? 'weekly' : 'once'); invalidate()}} />假如每周如此</label>
        <button className="xc-primary" type="submit" disabled={blocked || !taskId || !question.trim()}>{busy ? '析熙正在比较…' : '让析熙比较'}</button></form>
    </Plate>
    <div className="route-body">
      <Plate material={material} className="route-future">
        <header className="route-section-heading"><div><span className="xc-eyebrow">TWO POSSIBLE ROUTES</span><h3>{comparisonExists ? analysis?.facts.task.title ?? selected?.decision?.title ?? subject?.title ?? '历史安排' : '先想清楚，再改变安排'}</h3></div><nav aria-label="观察多久以后">{HORIZONS.map(item => <button type="button" key={item.id} aria-pressed={horizon === item.id} onClick={() => setHorizon(item.id)}>{item.label}</button>)}</nav></header>
        {legacy ? <div className="route-trend"><span className="route-conditional">以前保存的排程草案 · 没有记录模型判断和原路线</span><Notes title="候选安排" values={selected!.plans.map(plan => `${plan.title} · ${dayLabel(plan.date)} ${plan.start}–${plan.end}`)} /><Notes title="尚未排下" values={selected!.unscheduled.map(item => `${item.title}：${item.reason}`)} /></div> : horizon === 'week' ? <>
          <div className="route-rails" aria-label="当前路线与候选路线时间流">
            {[{label:'当前路线', plans: baseline, other: after, candidate:false}, {label:'候选路线', plans:after, other:baseline, candidate:true}].map(row => <section className="route-rail" key={row.label} data-candidate={row.candidate}><header><strong>{row.label}</strong><small>{row.candidate ? analysis?.candidate ?? '析熙会结合空档、截止日期与这个选择给出方案' : analysis?.current ?? '已保存的安排是比较起点'}</small></header>
              <div className="route-days">{dates.map((value, index) => {
                const entries = row.plans.filter(block => block.date === value)
                return <button type="button" key={value} aria-pressed={dayIndex === index} aria-label={`${row.label} ${dayLabel(value)}`} onClick={() => setDayIndex(index)}><time>{dayLabel(value)}</time>{entries.length ? entries.map(block => <span className="route-slot" key={block.id} data-changed={!row.other.some(old => sameTime(old, block))}>{block.start}–{block.end}<small>{row.other.some(old => sameTime(old, block)) ? '保留' : row.candidate ? '新位置' : '原位置'}</small></span>) : <span className="route-open">{comparisonExists ? '未安排这件事' : '—'}</span>}
                </button>
              })}</div></section>)}
          </div>
          <div className="route-day-detail"><strong>{dayLabel(chosenDate)}</strong><p>{comparisonExists ? `${baseline.filter(block => block.date === chosenDate).length} 段原安排 → ${after.filter(block => block.date === chosenDate).length} 段候选安排` : '选择具体事项，写下你想尝试的改变。两条路线会一起出现。'}</p><small>{day ? `当日原空闲 ${Math.floor(day.freeMin)} 分钟 · ${day.deadlines.length} 项截止` : '当前没有这天的核验信息'} · 金色标出变化</small></div>
        </> : <div className="route-trend"><span className="route-conditional">有前提的趋势 · 不会生成远期日程</span>{trend ? <><h3>{trend.summary}</h3><Notes title="成立的前提" values={[trend.condition]} /><Notes title="仍不确定" values={[trend.uncertainty]} /><Notes title="可观察的信号" values={analysis?.observations ?? []} /></> : <div className="route-empty">{comparisonExists ? '这份历史方案没有析熙的远期判断。重新比较后可以看到。' : '析熙会说明：如果持续这样选择，哪些影响可能累积，以及什么时候值得重新判断。'}</div>}</div>}
        <footer className="route-actions"><span>{stale ? '日程已变化，需要重新比较' : selected ? STATUS[selected.status] : '比较不会改动日历'}</span>
          {selected?.status === 'applied' && selected.operationId ? <button type="button" disabled={busy} onClick={() => void action(() => localApi(`/operations/${encodeURIComponent(selected.operationId!)}/undo`, {}), '已撤销采用，原日程已恢复', true)}>撤销采用</button> : <>
            {selected?.status === 'preview' && <button type="button" disabled={busy} onClick={() => void action(() => localApi('/companion/scenario/discard', {id:selected.id, expectedVersion:selected.version}), '已放下这份比较')}>先放下</button>}
            {canApply && <button type="button" className="xc-primary" disabled={blocked} onClick={() => void action(() => localApi('/companion/scenario/apply', {id:selected!.id, expectedVersion:selected!.version}), '已采用候选路线，日历已同步', true)}>采用这周的候选安排</button>}
          </>}
        </footer>
      </Plate>
      <Plate material={material} className="route-insight"><header className="route-section-heading"><h3>析熙怎么看</h3></header><nav className="route-insight-tabs" aria-label="路线说明">{([{id:'judgment',label:'权衡'}, {id:'facts',label:'已核验'}, {id:'observe',label:'再观察'}] as const).map(item => <button type="button" key={item.id} aria-pressed={detail === item.id} onClick={() => setDetail(item.id)}>{item.label}</button>)}</nav>
        <div className="route-insight-scroll">{analysis ? detail === 'judgment' ? <><span className="route-conditional">析熙判断</span><Notes title="得到什么" values={analysis.benefits} /><Notes title="付出什么" values={analysis.costs} /><Notes title="需要留意" values={analysis.risks} /><Notes title="改变主意时" values={analysis.recovery} /></> : detail === 'facts' ? <><Notes title="来自当前数据的事实" values={analysis.facts.verified} /><Notes title="未排下的部分" values={selected!.unscheduled.map(item => `${item.title}：${item.reason}`)} /><Notes title="核验提示" values={selected!.warnings} /><small>核验于 {new Date(analysis.facts.asOf).toLocaleString('zh-CN')}</small></> : <><Notes title="接下来观察" values={analysis.observations} /><Notes title="这次比较的假设" values={analysis.assumptions} /><Notes title="重新调整的办法" values={analysis.recovery} /></> : <div className="route-empty">{selected ? '这是以前保存的系统方案。重新比较后，析熙会给出自己的判断。' : '你的选择越具体，比较越有用。比如“今天休息”，或“这周把更多空课留给数学”。'}<p>近期看实际时段，远期看可能累积的影响。</p></div>}</div>
      </Plate>
    </div>
    {(tasksError || plannerError) && <p role="alert">{tasksError || plannerError}</p>}
  </div>
}
