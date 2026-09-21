import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Task } from '../domain/task'
import { agendaDate, localDay, shiftDay } from '../home/agenda'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { GlassMaterial } from '../home/GlassSurface'
import { WorkbenchIcon } from '../workbench/WorkbenchIcon'
import { setDecisionEffect } from '../prototype/decisionEffect'
import { localApi } from './api'
import { decisionProjection } from './decisionProjection'
import type { CompanionScenario, CompanionState, DecisionRecurrence, DecisionStrategy, ScenarioPlan } from './companionTypes'

type Action = <T>(operation: () => Promise<T>, success: string, changed?: boolean) => Promise<T | undefined>
type Props = {
  tasks: Task[]; tasksLoading: boolean; tasksError: string; state: CompanionState
  date: string; onDate: (value: string) => void; plannerRevision?: number
  plannerLoading: boolean; plannerError: string; loading: boolean; busy: boolean
  action: Action; material: GlassMaterial; initialScenarioId?: string
  exiting?: boolean
}
const PATHS = [
  { id: 'today', label: '今天优先完成', description: '把后面的时间留出来', branch: 0 },
  { id: 'split', label: '先做一小段', description: '今天推进，余下分开做', branch: 1 },
  { id: 'defer', label: '今天先放下', description: '从明天起，重新找时间', branch: 2 },
] as const
const MARKS = [
  { value: 0, day: 0, label: '当天' }, { value: 160, day: 1, label: '明天' },
  { value: 340, day: 6, label: '一周' }, { value: 540, day: 29, label: '一个月' },
  { value: 760, day: 89, label: '三个月' }, { value: 1000, day: 364, label: '一年' },
]
const STATUS = { preview: '待采用', applied: '已采用', undone: '已撤销', discarded: '已放下' }
const dateLabel = (date: string, withYear = false) => {
  const at = agendaDate(date)
  return at ? new Intl.DateTimeFormat('zh-CN', { ...(withYear ? { year: 'numeric' as const } : {}), month: 'numeric', day: 'numeric' }).format(at) : date
}
const duration = (minutes: number) => {
  const value = Math.max(0, Math.round(minutes))
  return value >= 60 ? `${Math.floor(value / 60)} 小时${value % 60 ? ` ${value % 60} 分` : ''}` : `${value} 分钟`
}
const dayAt = (value: number) => {
  const end = MARKS.findIndex(mark => mark.value >= value)
  if (end <= 0) return 0
  const a = MARKS[end - 1], b = MARKS[end]
  return Math.round(a.day + (b.day - a.day) * (value - a.value) / (b.value - a.value))
}
const taskDeadline = (task: Task) => agendaDate(task.due)?.getTime() ?? Infinity
function Plate({ children, material, className = '' }: { children: ReactNode; material: GlassMaterial; className?: string }) {
  return <div className={`decision-plate xc-glass ${className}`}><MeasuredGlassSurface radius={20} material={material} /><div className="xc-glass-content">{children}</div></div>
}

export function DecisionStudio({ tasks, tasksLoading, tasksError, state, date, onDate, plannerRevision, plannerLoading, plannerError, loading, busy, action, material, initialScenarioId, exiting = false }: Props) {
  const id = useId()
  const openTasks = useMemo(() => tasks.filter(task => !task.deletedAt && (task.status === 'todo' || task.status === 'doing'))
    .sort((a, b) => taskDeadline(a) - taskDeadline(b) || b.importance - a.importance || a.title.localeCompare(b.title)), [tasks])
  const [taskId, setTaskId] = useState('')
  const [strategy, setStrategy] = useState<DecisionStrategy>('today')
  const [recurrence, setRecurrence] = useState<DecisionRecurrence>('once')
  const [todayMin, setTodayMin] = useState(30)
  const [position, setPosition] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const [emphasis, setEmphasis] = useState(.5)
  const [expanded, setExpanded] = useState(false)
  const initialTarget = useRef<string | undefined>(undefined)
  const selected = state.scenarios.find(item => item.id === selectedId) ?? null
  const shown = selected?.date === date ? selected : null
  const selectedTask = tasks.find(task => task.id === taskId)
  const path = PATHS.find(item => item.id === strategy) ?? PATHS[0]
  const offset = dayAt(position)
  const futureDate = localDay(shiftDay(agendaDate(date) ?? new Date(), offset))
  const projection = useMemo(() => shown?.decision ? decisionProjection(shown, offset) : null, [shown, offset])
  const versions = useMemo(() => new Map(tasks.map(task => [task.id, task.updatedAt])), [tasks])
  const stale = shown?.status === 'preview' && (plannerRevision !== shown.baseRevision || versions.size !== Object.keys(shown.taskVersions).length || Object.entries(shown.taskVersions).some(([key, value]) => versions.get(key) !== value))
  const ready = Boolean(selectedTask && openTasks.some(task => task.id === taskId)) && !tasksLoading && !tasksError && !plannerLoading && !plannerError && !loading && !busy
  const legacy = Boolean(shown && !shown.decision)
  const blocks = projection ? (comparing ? projection.baseline : projection.candidate) : shown?.plans ?? []
  const visibleBlocks = blocks.filter(block => offset > 6 || block.date === futureDate)
  const focusDay = state.timeline.find(day => day.date === futureDate)
  const freshState = state.timeline[0]?.date === date
  const unresolved = shown?.unscheduled.find(item => item.taskId === taskId) ?? shown?.unscheduled[0]

  const restore = (scenario: CompanionScenario) => {
    setSelectedId(scenario.id); onDate(scenario.date); setComparing(false); setExpanded(false)
    if (scenario.decision) {
      setTaskId(scenario.decision.taskId); setStrategy(scenario.decision.strategy)
      setRecurrence(scenario.decision.recurrence); setTodayMin(scenario.decision.todayMin)
    }
  }
  useEffect(() => {
    if (initialScenarioId && initialTarget.current !== initialScenarioId) {
      const scenario = state.scenarios.find(item => item.id === initialScenarioId)
      if (scenario) { initialTarget.current = initialScenarioId; restore(scenario) }
    }
  }, [initialScenarioId, state.scenarios])
  useEffect(() => {
    if (!selectedId && !openTasks.some(task => task.id === taskId)) setTaskId(openTasks[0]?.id ?? '')
  }, [openTasks, taskId, selectedId])
  useEffect(() => {
    if (exiting) return
    setDecisionEffect({ active: true, horizon: position / 1000, branch: path.branch, comparing, emphasis })
  }, [position, path.branch, comparing, emphasis, exiting])
  useEffect(() => {
    const release = () => setComparing(false)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', release)
    return () => { setDecisionEffect({ active: false }); window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', release) }
  }, [])
  const invalidate = () => { setSelectedId(null); setComparing(false); setExpanded(false) }
  const create = async () => {
    if (!ready) return
    const result = await action(() => localApi<CompanionScenario>('/companion/decision', { date, taskId, strategy, recurrence, todayMin }), '路径已保存为草案，日历还没有改动')
    if (result) { setSelectedId(result.id); setComparing(false) }
  }
  const chooseHistory = (value: string) => {
    const scenario = state.scenarios.find(item => item.id === value)
    if (scenario) restore(scenario)
    else invalidate()
  }
  const hasChanges = Boolean(shown && shown.plans.length + shown.removedBlockIds.length > 0)
  const held = shown?.decision?.baseline.filter(block => !shown.removedBlockIds.includes(block.id)).length ?? 0
  const sourceWarning = tasksError || plannerError
  const title = comparing ? '原来的路径' : shown ? legacy ? '之前保存的安排' : path.label : '一个选择，几种明天。'
  const total = projection ? (comparing ? projection.baselineMin : projection.candidateMin) : shown?.metrics?.scheduledMin
  const far = offset > 6
  const released = projection?.freedTodayMin ?? 0
  const moved = projection?.tomorrowAddedMin ?? 0
  const longExplanation = !shown ? '先展开一条路径，再观察它随时间的变化。'
    : legacy ? '这份旧方案仅保存了近期安排；重新展开单项决策即可比较远期。'
    : recurrence === 'once' ? '仅这一次：本周以后的安排不再累加。暂无可证实的更远影响。'
    : '条件推演：假定每周都有同等工作量、照这一周分配。实际课表、假期与新任务可能改变结果。'
  const guidance = !shown ? '选事项 → 选路径 → 展开。拖动下方时间尺，黑洞和结果一起改变。'
    : stale ? '事项或时间表已有变化。重新推演后，再决定是否采用。'
    : unresolved ? unresolved.reason
    : far ? longExplanation
    : comparing ? '正在对照生成草案时的原安排，松开即可回到当前路径。'
    : `${visibleBlocks.length ? `${dateLabel(futureDate)}为这件事安排了 ${visibleBlocks.length} 段。` : `${dateLabel(futureDate)}没有为这件事安排时段。`}${held ? '固定或已开始的安排仍保留。' : '其他事项保持原样。'}`

  return <div className="decision-studio" data-comparing={comparing} data-branch={path.branch}>
    <Plate material={material} className="decision-control">
      <div className="decision-control-top">
        <label className="decision-subject" htmlFor={`${id}-task`}><span>01 · 你在考虑哪件事</span><select id={`${id}-task`} aria-label="选择推演事项" value={taskId} disabled={busy || tasksLoading} onChange={event => { setTaskId(event.target.value); invalidate() }}>
          {!openTasks.length && <option value="">{tasksLoading ? '正在读取事项' : '还没有开放事项'}</option>}
          {selectedId && selectedTask && !openTasks.some(task => task.id === taskId) && <option value={taskId}>{selectedTask.title} · 已关闭</option>}
          {openTasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}
        </select></label>
        <label className="decision-date">从这天开始<input type="date" aria-label="推演起始日期" value={date} min={localDay(new Date())} disabled={busy} onChange={event => { if (event.target.value) { onDate(event.target.value); invalidate() } }} /></label>
        <fieldset className="decision-recurrence"><legend>持续条件</legend><div>{(['once', 'weekly'] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={recurrence === value} onClick={() => { setRecurrence(value); invalidate() }}>{value === 'once' ? '只这一次' : '假如每周如此'}</button>)}</div></fieldset>
        <label className="decision-history"><span>保存的路径</span><select aria-label="选择已保存推演" disabled={busy} value={selectedId ?? ''} onChange={event => chooseHistory(event.target.value)}><option value="">新决策</option>{[...state.scenarios].reverse().map(item => <option key={item.id} value={item.id}>{item.decision?.title ?? '旧安排'} · {item.decision ? PATHS.find(p => p.id === item.decision?.strategy)?.label : dateLabel(item.date)} · {STATUS[item.status]}</option>)}</select></label>
      </div>
      <div className="decision-paths" role="group" aria-label="选择决策路径">{PATHS.map(item => <button type="button" key={item.id} data-path={item.id} disabled={busy} aria-pressed={strategy === item.id && !legacy} onClick={() => { setStrategy(item.id); invalidate() }}><span className="decision-path-number">0{item.branch + 1}</span><span><strong>{item.label}</strong><small>{item.description}</small></span><span className="decision-path-mark" aria-hidden="true" /></button>)}</div>
    </Plate>

    <div className="decision-stage">
      <section className="decision-space" aria-label="黑洞决策视界">
        <div className="decision-space-heading"><span className="xc-eyebrow">{offset === 0 ? '选择发生的地方' : `${offset + 1} 天的可能`}</span><h3>{title}</h3><p>{shown?.decision?.title ?? selectedTask?.title ?? '先把一件事交给析熙，再来这里看看。'}</p></div>
        <button type="button" className="decision-compare" aria-label="按住对照原来的路径" aria-pressed={comparing} disabled={!projection} onPointerDown={event => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); setComparing(true) }} onPointerUp={() => setComparing(false)} onPointerCancel={() => setComparing(false)} onLostPointerCapture={() => setComparing(false)} onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setComparing(true) } }} onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); setComparing(false) } }} onBlur={() => setComparing(false)}><WorkbenchIcon name="undo" />{comparing ? '原路径 · 松开返回' : '按住，对照原路径'}</button>
        <div className="decision-space-foot"><span className="decision-caption-dot" /><p>{guidance}</p><small>盘面形态表达路径变化；具体代价以右侧数据为准。</small></div>
      </section>
      <Plate material={material} className="decision-result">
        <header><div><span className="xc-eyebrow">{far ? '远期投入' : '眼前的变化'}</span><h3>{dateLabel(futureDate, far)}{far ? ' · 累计到这天' : ''}</h3></div><span className="decision-status">{comparing ? '原安排' : shown ? STATUS[shown.status] : '待推演'}</span></header>
        <div className="decision-main-metric" onPointerEnter={() => setEmphasis(1)} onPointerLeave={() => setEmphasis(.5)}><span>{far && recurrence === 'weekly' ? '假设累计安排' : far ? '本次安排合计' : '截至这天累计安排'}</span><strong>{total === undefined ? '—' : duration(total)}</strong><small>{!shown ? '基于你的事项、课表与可用时间' : far && recurrence === 'weekly' ? `每 7 天重复 · ${projection?.occurrences ?? 1} 次起始` : '安排时长，不代表已经完成'}</small></div>
        {projection && <dl className="decision-deltas"><div><dt>{released >= 0 ? '当天腾出' : '当天多占'}</dt><dd>{duration(Math.abs(released))}</dd></div><div><dt>{moved >= 0 ? '明天多占' : '明天腾出'}</dt><dd>{duration(Math.abs(moved))}</dd></div></dl>}
        {projection && <div className="decision-comparison-bars" aria-label="原安排与候选安排累计用时"><ComparisonBar label="原路径" value={projection.baselineMin} max={Math.max(1, projection.baselineMin, projection.candidateMin)} /><ComparisonBar label="这条路" value={projection.candidateMin} max={Math.max(1, projection.baselineMin, projection.candidateMin)} candidate /></div>}
        <div className="decision-evidence">
          {!shown ? <p>展开路径后，会列出挪到了哪天、占用了多久，以及截止前还排不下的部分。</p> : far ? <p>{longExplanation}</p> : <>
            <h4>{comparing ? '原来这天' : '这条路径 · 当天'}</h4>
            {visibleBlocks.length ? <ol aria-label="当天为这件事安排的时段">{visibleBlocks.slice(0, 2).map(block => <li key={block.id}><time>{block.start}–{block.end}</time></li>)}{visibleBlocks.length > 2 && <li title="完整时段可展开下方的安排与依据">另 {visibleBlocks.length - 2} 段</li>}</ol> : <p>当天没有这件事的时段。</p>}
            {freshState && focusDay && <small>当天原可支配 {duration(focusDay.availableMin)}</small>}
          </>}
          {unresolved && <p className="decision-risk">{unresolved.remainingMin === null ? '用时未知' : `仍有 ${duration(unresolved.remainingMin)} 未排下`}{far ? '，不能当作已经完成。' : ` · ${unresolved.reason}`}</p>}
          {projection?.unknownEffort && !unresolved && <p className="decision-risk">总工作量未确认，当前仅显示已有时段。</p>}
        </div>
      </Plate>
    </div>

    <Plate material={material} className="decision-timeline">
      <div className="decision-scrub-heading"><label htmlFor={`${id}-time`}>02 · 把时间往后推</label><output htmlFor={`${id}-time`}>{dateLabel(futureDate, far)} · {far ? recurrence === 'weekly' ? '条件推演' : '本次影响' : '近期真实日程'}</output></div>
      <input id={`${id}-time`} type="range" aria-label="拖动查看未来一年" aria-valuetext={`${dateLabel(futureDate)}，第 ${offset + 1} 天`} min={0} max={1000} step={1} value={position} onChange={event => setPosition(Number(event.target.value))} />
      <div className="decision-time-marks">{MARKS.map(mark => <button type="button" key={mark.value} data-day={mark.day} aria-pressed={position === mark.value} onClick={() => setPosition(mark.value)}>{mark.label}</button>)}</div>
      <div className="decision-action-row"><div className="decision-action-note">{strategy === 'split' && !shown ? <label>先做 <input type="number" aria-label="当天先做几分钟" min={5} max={720} step={5} value={todayMin} disabled={busy} onChange={event => setTodayMin(Math.min(720, Math.max(5, Number(event.target.value) || 5)))} /> 分钟</label> : <span>{sourceWarning || (stale ? '数据已变化，请重新推演' : shown?.status === 'applied' ? '已写入日历，可撤销' : shown ? '草案已保存 · 仅采用本次 7 天安排' : '先比较，再写入日历')}</span>}</div>
        {shown && <button type="button" className="decision-details-toggle" aria-expanded={expanded} aria-controls={`${id}-details`} onClick={() => setExpanded(value => !value)}>{expanded ? '收起明细' : '安排与依据'}<WorkbenchIcon name="chevron" /></button>}
        {shown?.status === 'applied' && shown.operationId ? <button type="button" disabled={busy} onClick={() => void action(() => localApi(`/operations/${encodeURIComponent(shown.operationId!)}/undo`, {}), '已撤销这次调整，原安排已恢复', true)}><WorkbenchIcon name="undo" />撤销采用</button> : shown?.status === 'preview' && !stale ? <><button type="button" disabled={busy} onClick={() => void action(() => localApi('/companion/scenario/discard', { id: shown.id, expectedVersion: shown.version }), '草案已放下，原安排未变')}>放下</button><button type="button" className="xc-primary decision-apply" disabled={busy || loading || plannerLoading || tasksLoading || Boolean(sourceWarning) || !hasChanges} onClick={() => void action(() => localApi('/companion/scenario/apply', { id: shown.id, expectedVersion: shown.version }), '已采用这条路径，日历已同步', true)}>采用这条路径<WorkbenchIcon name="check" /></button></> : <button type="button" className="xc-primary decision-create" disabled={!ready} onClick={() => void create()}>{busy ? '正在展开…' : shown ? '重新推演' : '展开这条路径'}<WorkbenchIcon name="arrow" /></button>}
      </div>
      {sourceWarning && <p className="decision-risk" role="alert">{sourceWarning}</p>}
    </Plate>
    <div id={`${id}-details`} className="decision-detail-reveal" data-open={expanded} aria-hidden={!expanded} inert={!expanded}><div>{shown && <Plate material={material} className="decision-details"><header><h3>这条路径如何落地</h3><span>起始 {dateLabel(shown.date)} · 未来 {shown.days} 天</span></header><div className="decision-detail-columns"><PlanList title="原来的安排" plans={projection?.baseline ?? []} /><PlanList title="采用后的安排" plans={projection?.candidate ?? shown.plans} /></div><ul>{shown.warnings.map((warning, index) => <li key={index}>{warning}</li>)}{shown.unscheduled.map(item => <li key={item.taskId}>{item.title}：{item.reason}</li>)}</ul><p>依据：保存时的任务用时、时间表与截止时间。采用前会重新核对版本、可用时段和冲突。</p></Plate>}</div></div>
  </div>
}

function ComparisonBar({ label, value, max, candidate = false }: { label: string; value: number; max: number; candidate?: boolean }) {
  return <div data-candidate={candidate}><span>{label}</span><i><b style={{ width: `${value / max * 100}%` }} /></i><small>{duration(value)}</small></div>
}
function PlanList({ title, plans }: { title: string; plans: ScenarioPlan[] }) {
  return <section><h4>{title}</h4>{plans.length ? <ol>{[...plans].sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`)).map(plan => <li key={plan.id}><time>{dateLabel(plan.date)} · {plan.start}–{plan.end}</time><span>{plan.title}</span></li>)}</ol> : <p>没有保存的时段</p>}</section>
}
