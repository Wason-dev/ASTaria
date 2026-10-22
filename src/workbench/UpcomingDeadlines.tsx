import { forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { collectionProgress, collectionRemaining, taskEntries } from '../domain/taskCollections'
import type { TaskCollection } from '../domain/taskCollections'
import { CollectionIcon } from '../ui/CollectionIcon'
import type { Task } from '../domain/task'
import { upcomingDeadlines, unconfirmedDeadlineCount } from './deadlines'
import type { DeadlineItem } from './deadlines'
import { collectionExplanations, collectionSchedulingFacts, deadlineContext, estimateLabel, scheduleExplanationsFor } from './briefing'
import type { ScheduleExplanations, ScheduledMinutes } from './briefing'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { Appearance } from './appearance'
import { WorkbenchIcon } from './WorkbenchIcon'
import type { WorkbenchIconName } from './WorkbenchIcon'
import './deadline-panel.css'

export function DeadlineSummary({ tasks, now, onReveal }: { tasks: Task[]; now: Date; onReveal: () => void }) {
  const items = upcomingDeadlines(tasks, now)
  const first = items[0]
  if (!first) return null
  return <button className="wb-ddl-compact" data-urgency={first.urgency} onClick={onReveal} aria-label={`${first.remainingLabel}，${first.task.title}，查看全部 ${items.length} 项截止事项`}>
    <span className="wb-ddl-compact-label">UPCOMING <span>{items.length}</span></span>
    <span className="wb-ddl-compact-copy"><strong>{first.remainingLabel}</strong><span>{first.task.title}</span></span>
    <span className="wb-ddl-compact-arrow"><WorkbenchIcon name="chevron" /></span>
  </button>
}

export const UpcomingDeadlines = forwardRef<HTMLHeadingElement, {
  tasks: Task[]; now: Date; disabled: boolean; loading: boolean; error: string; appearance: Appearance;
  highlighted: boolean; onSelect: (id: string) => void; onRetry: () => void
  focusMin: number; getSpentMs: (id: string) => number; scheduledMinutes: ScheduledMinutes
  embedded?: boolean; revealTaskId?: string | null
  /** Optional planner projection: taskId -> Xixi's written explanation. */
  scheduleExplanations?: ScheduleExplanations
}>(function UpcomingDeadlines({ tasks, now, disabled, loading, error, highlighted, onSelect, onRetry, focusMin, getSpentMs, scheduledMinutes, appearance, embedded = false, revealTaskId, scheduleExplanations }, ref) {
  const items = useMemo(() => {
    const raw = upcomingDeadlines(tasks, now)
    const byId = new Map(raw.map(item => [item.task.id, item]))
    return taskEntries(raw.map(item => item.task), tasks).map(entry => ({ ...byId.get(entry.kind === 'task' ? entry.id : entry.visible[0].id)!, collection: entry.kind === 'collection' ? entry : undefined }))
  }, [tasks, now])
  const unconfirmed = unconfirmedDeadlineCount(tasks)
  const viewport = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLOListElement>(null)
  const listId = useId()
  const [viewportWidth, setViewportWidth] = useState(0)
  const [listHeight, setListHeight] = useState<number>()
  const [anchorId, setAnchorId] = useState<string | null>(revealTaskId ?? null)
  const [pageRevision, setPageRevision] = useState(0)
  const pageSize = viewportWidth >= 800 ? 3 : viewportWidth >= 500 ? 2 : 1
  const anchorIndex = Math.max(0, items.findIndex(item => item.task.id === anchorId || item.collection?.tasks.some(task => task.id === anchorId)))
  const page = Math.floor(anchorIndex / pageSize)
  const pageCount = Math.ceil(items.length / pageSize)
  const pageStart = page * pageSize
  const pageEnd = Math.min(items.length, pageStart + pageSize)
  const nodeGap = 20
  const nodeWidth = Math.max(0, (viewportWidth - nodeGap * (pageSize - 1)) / pageSize)
  const hiddenItems = items.filter((_, index) => index < pageStart || index >= pageEnd)
  const hiddenOverdue = hiddenItems.filter(item => item.urgency === 'overdue').length
  const hiddenSoon = hiddenItems.filter(item => item.urgency === 'urgent' || item.urgency === 'soon').length
  const hiddenNotice = [hiddenOverdue > 0 ? `${hiddenOverdue} 项逾期` : '', hiddenSoon > 0 ? `${hiddenSoon} 项即将截止` : ''].filter(Boolean).join(' · ')

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => {
      const next = element.clientWidth
      const focused = document.activeElement?.closest<HTMLElement>('.wb-ddl-item')?.querySelector<HTMLElement>('[data-deadline-id]')
      // Keep a keyboard-focused node on its page when the viewport crosses a
      // page-size breakpoint, rather than making the focused element inert.
      if (focused && element.contains(focused)) setAnchorId(focused.dataset.deadlineId ?? null)
      setViewportWidth(current => Math.abs(current - next) < .5 ? current : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [loading, error, items.length])

  useLayoutEffect(() => {
    if (revealTaskId) setAnchorId(revealTaskId)
  }, [revealTaskId])

  useLayoutEffect(() => {
    const element = track.current
    if (!element || viewportWidth <= 0) return
    let frame = 0
    const rows = [...element.children] as HTMLElement[]
    const measure = () => {
      const next = Math.max(0, ...rows.slice(pageStart, pageEnd).map(row => row.getBoundingClientRect().height))
      setListHeight(current => current !== undefined && Math.abs(current - next) < .5 ? current : next)
    }
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) })
    rows.forEach(row => observer.observe(row))
    measure()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [items, pageStart, pageEnd, viewportWidth, loading, error])

  const changePage = (next: number) => {
    const index = Math.max(0, Math.min(pageCount - 1, next)) * pageSize
    const task = items[index]?.task
    if (!task) return
    setAnchorId(task.id)
    setPageRevision(value => value + 1)
  }
  return <aside className={`wb-deadlines wb-deadline-timeline${embedded ? ' wb-ddl-embedded' : ' wb-glass'}`} data-highlighted={highlighted} data-page={page} data-page-size={pageSize} data-measured={viewportWidth > 0} aria-labelledby="wb-ddl-heading">
    {!embedded && <MeasuredGlassSurface radius={appearance.radius} material={appearance} />}
    <div className={embedded ? 'wb-ddl-content' : 'wb-glass-content wb-ddl-content'}>
      <header className="wb-ddl-heading">
        <div><span className="wb-eyebrow">UPCOMING</span><h3 id="wb-ddl-heading" ref={ref} tabIndex={-1}>截止在前方 <span>{items.length}</span></h3></div>
        <WorkbenchIcon name="calendar" />
      </header>
      {loading ? <p className="wb-section-empty" role="status">正在读取截止事项</p> : error ? <div className="wb-section-empty"><p>截止事项暂未读取成功</p><button className="wb-inline-button" onClick={onRetry}>重新读取</button></div> : <>
        {items.length === 0 && <p className="wb-section-empty">暂时没有明确的截止日期<br /><span>有日期的事项会出现在这里</span></p>}
        {items.length > 0 && <>
          <div ref={viewport} className="wb-ddl-timeline-window" style={listHeight === undefined ? undefined : { height: listHeight }}>
            <ol ref={track} id={listId} className="wb-ddl-timeline-track" aria-label="按截止时间排列的事项" style={{ '--wb-ddl-node-width': `${nodeWidth}px`, '--wb-ddl-node-gap': `${nodeGap}px`, transform: `translateX(${-pageStart * (nodeWidth + nodeGap)}px)` } as CSSProperties}>
              {items.map((item, index) => <DeadlineRow key={item.task.id} item={item} collection={item.collection} featured={index === 0} offpage={index < pageStart || index >= pageEnd} pageRevision={pageRevision} now={now} focusMin={focusMin} getSpentMs={getSpentMs} scheduledMinutes={scheduledMinutes} scheduleExplanations={scheduleExplanations} appearance={appearance} disabled={disabled} onSelect={onSelect} />)}
            </ol>
          </div>
          {pageCount > 1 && <nav className="wb-ddl-pager" aria-label="截止时间线翻页">
            <span className="wb-ddl-page-alert" data-urgency={hiddenOverdue ? 'overdue' : 'soon'}>{hiddenNotice ? `其他页 · ${hiddenNotice}` : `其他页还有 ${hiddenItems.length} 项`}</span>
            <div className="wb-ddl-page-controls">
              <button className="wb-ddl-page-prev wb-icon-button" aria-label="更早的截止事项" title="更早的截止事项" data-tooltip="更早的截止事项" aria-controls={listId} disabled={disabled || page === 0} onClick={() => changePage(page - 1)}><WorkbenchIcon name="chevron" /><span className="wb-tooltip" role="tooltip">更早的截止事项</span></button>
              <span className="wb-ddl-page-status" role="status" aria-live="polite" aria-atomic="true" aria-label={`第 ${page + 1} 页，共 ${pageCount} 页，显示第 ${pageStart + 1} 至 ${pageEnd} 项，共 ${items.length} 项`}>{pageStart + 1}–{pageEnd}<span> / {items.length}</span></span>
              <button className="wb-ddl-page-next wb-icon-button" aria-label="后续截止事项" title="后续截止事项" data-tooltip="后续截止事项" aria-controls={listId} disabled={disabled || page + 1 >= pageCount} onClick={() => changePage(page + 1)}><WorkbenchIcon name="chevron" /><span className="wb-tooltip" role="tooltip">后续截止事项</span></button>
            </div>
          </nav>}
        </>}
        {unconfirmed > 0 && <p className="wb-ddl-unconfirmed">{unconfirmed} 项截止日期待确认</p>}
      </>}
    </div>
  </aside>
})

/** Fact-only collection panel labels, so no model wording is implied. */
const COLLECTION_FACT_ICONS: Record<string, WorkbenchIconName> = {
  截止: 'calendar', 进度: 'check', 已排: 'hourglass', 专注: 'timer',
}

function DeadlineRow({ item, collection, featured, offpage, pageRevision, now, focusMin, getSpentMs, scheduledMinutes, scheduleExplanations, appearance, disabled, onSelect }: {
  item: DeadlineItem; collection?: TaskCollection; featured: boolean; offpage: boolean; pageRevision: number; now: Date
  focusMin: number; getSpentMs: (id: string) => number; scheduledMinutes: ScheduledMinutes
  scheduleExplanations?: ScheduleExplanations; appearance: Appearance; disabled: boolean; onSelect: (id: string) => void
}) {
  const context = deadlineContext(item.task, now, focusMin, getSpentMs, scheduledMinutes)
  const [expanded, setExpanded] = useState(false)
  const regionId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const spentMs = getSpentMs(item.task.id)
  const estimateText = estimateLabel(item.task, scheduledMinutes)
  const explanations = scheduleExplanationsFor(scheduleExplanations, item.task.id)
  const hasExplanations = explanations.length > 0
  const factFields: Array<{ icon: WorkbenchIconName; label: string }> = [
    { icon: 'calendar', label: '截止' }, { icon: 'hourglass', label: '用时' }, { icon: 'timer', label: '已专注' },
  ]
  const facts = context.facts.slice(0, factFields.length)
  useEffect(() => { setExpanded(false) }, [pageRevision])
  useEffect(() => { if (offpage) setExpanded(false) }, [offpage])
  // A refreshed snapshot can drop a written explanation while its disclosure is
  // open; a collection always keeps its factual scheduling entry.
  useEffect(() => { if (!collection && !hasExplanations) setExpanded(false) }, [collection, hasExplanations])
  if (collection) {
    const reasons = collectionExplanations(collection.tasks, scheduleExplanations)
    const hasWrittenReasons = reasons.common.length > 0 || reasons.items.length > 0
    const schedulingFacts = hasWrittenReasons ? [] : collectionSchedulingFacts(collection, item.dateLabel, item.remainingLabel, scheduledMinutes, getSpentMs)
    const reasonName = hasWrittenReasons ? '建议依据' : '安排信息'
    return <li className="wb-ddl-item" data-urgency={item.urgency} data-offpage={offpage} inert={offpage} aria-hidden={offpage} onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
      <time className="wb-ddl-node-date" dateTime={collection.due}>{item.dateLabel}</time><span className="wb-ddl-node-dot" aria-hidden="true" />
      <div className="wb-ddl-card"><button className="wb-ddl-select" data-deadline-id={item.task.id} data-focus-origin={collection.id} disabled={disabled} onClick={() => onSelect(item.task.id)} aria-label={`${collection.name}，${collectionProgress(collection)}，${item.remainingLabel}，查看集合`}>
        <span className="wb-ddl-copy"><span className="wb-ddl-status"><span className="wb-ddl-countdown">{item.remainingLabel}</span></span><strong className="wb-ddl-collection-title"><CollectionIcon /><span>{collection.name}</span></strong><span className="wb-ddl-meta">{collectionProgress(collection)}</span><span className="wb-ddl-advice">{collectionRemaining(collection)}</span></span><span className="wb-ddl-arrow"><WorkbenchIcon name="arrow" /></span>
      </button>
        <button ref={toggle} className="wb-reason-toggle wb-ddl-reason-toggle wb-icon-button" disabled={disabled} aria-label={`${expanded ? '收起' : '查看'}「${collection.name}」的${reasonName}`} title={expanded ? `收起${reasonName}` : reasonName} data-tooltip={expanded ? `收起${reasonName}` : reasonName} aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded(value => !value)}><MeasuredGlassSurface radius={13} material={appearance} /><WorkbenchIcon name="info" /><span className="wb-tooltip" role="tooltip">{expanded ? `收起${reasonName}` : reasonName}</span></button>
      </div>
      <div className="wb-ddl-details">
        <div className="wb-insight-reveal wb-ddl-evidence" data-open={expanded} inert={!expanded} aria-hidden={!expanded} id={regionId} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}><div>{hasWrittenReasons ? <>
          {reasons.common.length > 0 && <ul className="wb-ddl-collection-common">{reasons.common.map(group => <li key={group.reason}><span className="wb-ddl-evidence-label"><WorkbenchIcon name="xixi" />共同说明</span><p>{group.reason}</p><small className="wb-ddl-reason-titles">{group.titles.join('、')}</small></li>)}</ul>}
          {reasons.items.length > 0 && <ul className="wb-ddl-collection-items">{reasons.items.map(member => <li key={member.id}><strong className="wb-ddl-collection-member">{member.title}</strong>{member.reasons.map(reason => <p key={reason}>{reason}</p>)}</li>)}</ul>}
        </> : <>
          <p className="wb-ddl-facts-heading">安排信息</p>
          <ul>{schedulingFacts.map(fact => <li key={fact.label}><span className="wb-ddl-evidence-label"><WorkbenchIcon name={COLLECTION_FACT_ICONS[fact.label] ?? 'info'} />{fact.label}</span><p>{fact.value}</p></li>)}</ul>
        </>}</div></div>
      </div>
    </li>
  }
  return <li className="wb-ddl-item" data-urgency={item.urgency} data-offpage={offpage} inert={offpage} aria-hidden={offpage} onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
    <time className="wb-ddl-node-date" dateTime={item.task.due} aria-label={`${item.dateLabel}截止`}>{item.dateLabel}</time>
    <span className="wb-ddl-node-dot" aria-hidden="true" />
    <div className="wb-ddl-card">
    <button className="wb-ddl-select" data-deadline-id={item.task.id} disabled={disabled} onClick={() => onSelect(item.task.id)} aria-label={`${item.task.title}，${item.remainingLabel}，${item.dateLabel}截止，${context.effortLabel}，进入专注`}>
      <span className="wb-ddl-copy"><span className="wb-ddl-status"><span className="wb-ddl-countdown">{item.remainingLabel}</span></span><strong>{item.task.title}</strong><span className="wb-ddl-meta"><span className="wb-ddl-effort" title={estimateText ?? '用时待估'}><WorkbenchIcon name="hourglass" />{estimateText ?? '待估'}</span>{spentMs > 0 && <span className="wb-ddl-effort" title={`累计专注 ${Math.floor(spentMs / 60000)} 分钟`}><WorkbenchIcon name="timer" />{spentMs < 60000 ? '<1' : Math.floor(spentMs / 60000)} 分钟</span>}</span>{featured && hasExplanations && <span className="wb-ddl-advice" style={{ overflowWrap: 'anywhere' }}>{explanations[0]}</span>}</span>
      <span className="wb-ddl-arrow"><WorkbenchIcon name="arrow" /></span>
    </button>
      {hasExplanations && <button ref={toggle} className="wb-reason-toggle wb-ddl-reason-toggle wb-icon-button" disabled={disabled} aria-label={expanded ? `收起「${item.task.title}」的建议依据` : `查看「${item.task.title}」的建议依据`} title={expanded ? '收起依据' : '建议依据'} data-tooltip={expanded ? '收起依据' : '建议依据'} aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded(value => !value)}><MeasuredGlassSurface radius={13} material={appearance} /><WorkbenchIcon name="info" /><span className="wb-tooltip" role="tooltip">{expanded ? '收起依据' : '建议依据'}</span></button>}
    </div>
    {hasExplanations && <div className="wb-ddl-details">
      <div className="wb-insight-reveal wb-ddl-evidence" data-open={expanded} inert={!expanded} aria-hidden={!expanded} id={regionId} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}><div><ul>{explanations.map((reason, index) => <li key={`reason-${index}`}><span className="wb-ddl-evidence-label"><WorkbenchIcon name="xixi" />日程理由</span><p>{reason}</p></li>)}{facts.map((fact, index) => <li key={`fact-${index}`}><span className="wb-ddl-evidence-label"><WorkbenchIcon name={factFields[index].icon} />{factFields[index].label}</span><p>{fact}</p></li>)}</ul></div></div>
    </div>}
  </li>
}
