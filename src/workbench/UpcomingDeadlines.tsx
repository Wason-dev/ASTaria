import { forwardRef, useId, useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { upcomingDeadlines, unconfirmedDeadlineCount } from './deadlines'
import type { DeadlineItem } from './deadlines'
import { deadlineContext } from './briefing'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { Appearance } from './appearance'

export function DeadlineSummary({ tasks, now, onReveal }: { tasks: Task[]; now: Date; onReveal: () => void }) {
  const items = upcomingDeadlines(tasks, now)
  const first = items[0]
  if (!first) return null
  return <button className="wb-ddl-compact" data-urgency={first.urgency} onClick={onReveal} aria-label={`${first.remainingLabel}，${first.task.title}，查看全部 ${items.length} 项截止事项`}>
    <span className="wb-ddl-compact-label">UPCOMING <span>{items.length}</span></span>
    <span className="wb-ddl-compact-copy"><strong>{first.remainingLabel}</strong><span>{first.task.title}</span></span>
    <span className="wb-ddl-compact-arrow" aria-hidden="true">↓</span>
  </button>
}

export const UpcomingDeadlines = forwardRef<HTMLHeadingElement, {
  tasks: Task[]; now: Date; disabled: boolean; loading: boolean; error: string; appearance: Appearance;
  highlighted: boolean; onSelect: (id: string) => void; onRetry: () => void
  focusMin: number; getSpentMs: (id: string) => number
}>(function UpcomingDeadlines({ tasks, now, disabled, loading, error, highlighted, onSelect, onRetry, focusMin, getSpentMs, appearance }, ref) {
  const items = upcomingDeadlines(tasks, now)
  const unconfirmed = unconfirmedDeadlineCount(tasks)
  return <aside className="wb-deadlines wb-glass" data-highlighted={highlighted} aria-labelledby="wb-ddl-heading">
    <MeasuredGlassSurface radius={appearance.radius} material={appearance} />
    <div className="wb-glass-content">
    <header className="wb-ddl-heading">
      <div><span className="wb-eyebrow">UPCOMING</span><h3 id="wb-ddl-heading" ref={ref} tabIndex={-1}>截止在前方 <span>{items.length}</span></h3></div>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>
    </header>
    <p className="wb-ddl-caption">按截止时间排列，越近越清晰</p>
    {loading ? <p className="wb-section-empty" role="status">正在读取截止事项</p> : error ? <div className="wb-section-empty"><p>截止事项暂未读取成功</p><button className="wb-inline-button" onClick={onRetry}>重新读取</button></div> : <>
      {items.length === 0 && <p className="wb-section-empty">暂时没有明确的截止日期<br /><span>有日期的事项会出现在这里</span></p>}
      {items.length > 0 && <ol className="wb-ddl-grid" aria-label="按截止时间排列的事项">{items.map((item, index) => <DeadlineRow key={item.task.id} item={item} featured={index === 0} now={now} focusMin={focusMin} getSpentMs={getSpentMs} disabled={disabled} onSelect={onSelect} />)}</ol>}
      {unconfirmed > 0 && <p className="wb-ddl-unconfirmed">{unconfirmed} 项截止日期待确认</p>}
    </>}
    </div>
  </aside>
})

function DeadlineRow({ item, featured, now, focusMin, getSpentMs, disabled, onSelect }: { item: DeadlineItem; featured: boolean; now: Date; focusMin: number; getSpentMs: (id: string) => number; disabled: boolean; onSelect: (id: string) => void }) {
  const context = deadlineContext(item.task, now, focusMin, getSpentMs)
  const [expanded, setExpanded] = useState(false)
  const regionId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  return <li className="wb-ddl-item" data-urgency={item.urgency} onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
    <button className="wb-ddl-select" data-deadline-id={item.task.id} disabled={disabled} onClick={() => onSelect(item.task.id)} aria-label={`${item.task.title}，${item.remainingLabel}，${item.dateLabel}截止，${context.effortLabel}，${context.suggestion}，进入专注`}>
      <span className="wb-ddl-marker" aria-hidden="true" />
      <span className="wb-ddl-copy"><span className="wb-ddl-status"><span className="wb-ddl-countdown">{item.remainingLabel}</span><span className="wb-ddl-phase">{item.urgency === 'overdue' ? '已逾期' : item.urgency === 'urgent' || item.urgency === 'soon' ? '即将截止' : '后续'}</span></span><strong>{item.task.title}</strong><span className="wb-ddl-meta"><time dateTime={item.task.due}>{item.dateLabel}截止</time><span className="wb-ddl-effort">{context.effortLabel}</span></span>{featured && <span className="wb-ddl-advice" data-tone={context.tone}>{context.suggestion}</span>}</span>
      <span className="wb-ddl-arrow" aria-hidden="true">↗</span>
    </button>
    <button ref={toggle} className="wb-reason-toggle wb-ddl-reason-toggle" disabled={disabled} aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded(value => !value)}>建议依据 <span aria-hidden="true">{expanded ? '−' : '+'}</span></button>
    <div className="wb-insight-reveal wb-ddl-evidence" data-open={expanded} inert={!expanded} aria-hidden={!expanded} id={regionId} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}><div>{!featured && <p className="wb-ddl-expanded-advice">{context.suggestion}</p>}<ul>{context.evidence.map(reason => <li key={reason}>{reason}</li>)}</ul></div></div>
  </li>
}
