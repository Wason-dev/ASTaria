import { forwardRef } from 'react'
import type { Task } from '../domain/task'
import { upcomingDeadlines, unconfirmedDeadlineCount } from './deadlines'
import type { DeadlineItem } from './deadlines'

const SECTIONS = [
  { label: '已逾期', kinds: ['overdue'] },
  { label: '即将截止', kinds: ['urgent', 'soon'] },
  { label: '后续', kinds: ['upcoming', 'later'] },
] as const

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
  tasks: Task[]; now: Date; disabled: boolean; loading: boolean; error: string;
  highlighted: boolean; onSelect: (id: string) => void; onRetry: () => void
}>(function UpcomingDeadlines({ tasks, now, disabled, loading, error, highlighted, onSelect, onRetry }, ref) {
  const items = upcomingDeadlines(tasks, now)
  const unconfirmed = unconfirmedDeadlineCount(tasks)
  return <aside className="wb-deadlines" data-highlighted={highlighted} aria-labelledby="wb-ddl-heading">
    <header className="wb-ddl-heading">
      <div><span className="wb-eyebrow">UPCOMING</span><h3 id="wb-ddl-heading" ref={ref} tabIndex={-1}>截止在前方 <span>{items.length}</span></h3></div>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>
    </header>
    <p className="wb-ddl-caption">按截止时间排列，越近越清晰</p>
    {loading ? <p className="wb-section-empty" role="status">正在读取截止事项</p> : error ? <div className="wb-section-empty"><p>截止事项暂未读取成功</p><button className="wb-inline-button" onClick={onRetry}>重新读取</button></div> : <>
      {items.length === 0 && <p className="wb-section-empty">暂时没有明确的截止日期<br /><span>有日期的事项会出现在这里</span></p>}
      {SECTIONS.map(section => {
        const rows = items.filter(item => (section.kinds as readonly string[]).includes(item.urgency))
        return rows.length > 0 && <section className="wb-ddl-group" key={section.label} aria-label={section.label}>
          <h4>{section.label}<span>{rows.length}</span></h4>
          <ol>{rows.map(item => <DeadlineRow key={item.task.id} item={item} disabled={disabled} onSelect={onSelect} />)}</ol>
        </section>
      })}
      {unconfirmed > 0 && <p className="wb-ddl-unconfirmed">{unconfirmed} 项截止日期待确认</p>}
    </>}
  </aside>
})

function DeadlineRow({ item, disabled, onSelect }: { item: DeadlineItem; disabled: boolean; onSelect: (id: string) => void }) {
  return <li className="wb-ddl-item" data-urgency={item.urgency}>
    <button data-deadline-id={item.task.id} disabled={disabled} onClick={() => onSelect(item.task.id)} aria-label={`${item.task.title}，${item.remainingLabel}，${item.dateLabel}截止，进入专注`}>
      <span className="wb-ddl-marker" aria-hidden="true" />
      <span className="wb-ddl-copy"><span className="wb-ddl-countdown">{item.remainingLabel}</span><strong>{item.task.title}</strong><time dateTime={item.task.due}>{item.dateLabel}</time></span>
      <span className="wb-ddl-arrow" aria-hidden="true">↗</span>
    </button>
  </li>
}
