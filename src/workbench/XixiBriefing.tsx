import { useId, useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { Appearance } from './appearance'
import type { WorkbenchBriefing, BriefingNotice } from './briefing'
import { WorkbenchIcon as Icon } from './WorkbenchIcon'

function XixiMark() {
  return <svg className="wb-xixi-mark" viewBox="0 0 28 28" aria-hidden="true"><ellipse cx="14" cy="14" rx="11" ry="6" transform="rotate(-32 14 14)" /><circle cx="14" cy="14" r="4" /><circle className="wb-xixi-satellite" cx="23" cy="8" r="1.5" /></svg>
}

export function XixiBriefing({ briefing, appearance, preview, disabled, focusMin, restMin, onSelect, onCapture, embedded = false, tasks = [] }: {
  briefing: WorkbenchBriefing; appearance: Appearance; preview: boolean; disabled: boolean;
  embedded?: boolean; tasks?: Task[];
  focusMin: number; restMin: number; onSelect: (id: string) => void; onCapture: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const reasonId = useId()
  const toggle = useRef<HTMLButtonElement>(null)
  const recommendation = briefing.recommendation
  return <section className={`wb-brief${embedded ? ' wb-brief-embedded' : ' wb-glass'}`} aria-label="析熙今日简报" onKeyDown={event => { if (event.key === 'Escape' && expanded) { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}>
    {!embedded && <MeasuredGlassSurface radius={appearance.radius} material={appearance} />}
    <div className="wb-glass-content">
      <header className="wb-brief-header"><span className="wb-xixi-identity"><XixiMark /><strong>析熙</strong><span>今日简报</span></span><span className="wb-brief-source">{preview ? '示例 · 本地建议' : '本地建议'}</span></header>
      <div className="wb-brief-main"><div className="wb-brief-message">
        <h3>{recommendation?.headline ?? (briefing.completedTodayCount ? '今天已经向前走了一步' : '给今天留一个清楚的起点')}</h3>
        <p>{recommendation?.summary ?? '收下想做的事，再一起决定先从哪里开始'}</p>
        <div className="wb-brief-actions">
          {recommendation ? <button className="wb-brief-start" disabled={disabled} data-focus-origin={`brief-${recommendation.task.id}`} onClick={() => onSelect(recommendation.task.id)}>开始这一项 <span aria-hidden="true">↗</span></button> : <button className="wb-brief-start" disabled={disabled} onClick={onCapture}>交给析熙 <span aria-hidden="true">↗</span></button>}
          {recommendation && <button ref={toggle} className="wb-reason-toggle wb-icon-button" disabled={disabled} aria-label={expanded ? '收起建议依据' : '查看建议依据'} data-tooltip="建议依据" aria-expanded={expanded} aria-controls={reasonId} onClick={() => setExpanded(value => !value)}><Icon name="info" /><span className="wb-tooltip" role="tooltip">建议依据</span></button>}
        </div>
      </div><div className="wb-brief-rhythm"><span>按自己的节奏</span><p><strong>{focusMin}</strong><span> / {restMin}</span></p><small>分钟专注 / 分钟休息</small><span className="wb-brief-estimate">{briefing.estimatedMin > 0 ? `可开始事项 · 已估 ${briefing.estimatedMin} 分钟` : '可开始事项 · 用时待估'}{briefing.unestimatedCount > 0 && <small>另有 {briefing.unestimatedCount} 项尚未估时</small>}</span></div></div>
      <div className="wb-insight-reveal" data-open={expanded && Boolean(recommendation)} inert={!expanded || !recommendation} aria-hidden={!expanded || !recommendation} id={reasonId} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}><div><div className="wb-brief-evidence"><span>这条建议依据</span><ul>{recommendation?.evidence.map(reason => <li key={reason}>{reason}</li>)}</ul><small>依据当前事项生成，未计入课表与空闲时段</small></div></div></div>
      {embedded && briefing.notices.length > 0 && <XixiWatch compact notices={briefing.notices} tasks={tasks} disabled={disabled} onSelect={onSelect} />}
    </div>
  </section>
}

export function XixiWatch({ notices, tasks, disabled, onSelect, compact = false }: { notices: BriefingNotice[]; tasks: Task[]; disabled: boolean; onSelect: (id: string) => void; compact?: boolean }) {
  return <section className="wb-watch" aria-label="析熙留意到">
    {!compact && <header><span className="wb-xixi-identity"><XixiMark /><strong>析熙留意到</strong></span><span>留一点余地</span></header>}
    {notices.length ? notices.map(notice => <Notice key={notice.id} notice={notice} tasks={tasks} disabled={disabled} onSelect={onSelect} compact={compact} />) : <p className="wb-watch-empty">暂时没有额外提醒<br /><span>有需要留意的地方，会在这里告诉你</span></p>}
  </section>
}

function Notice({ notice, tasks, disabled, onSelect, compact }: { notice: BriefingNotice; tasks: Task[]; disabled: boolean; onSelect: (id: string) => void; compact: boolean }) {
  const related = tasks.filter(task => notice.taskIds.includes(task.id))
  return <div className="wb-watch-item"><h4 title={notice.body}>{compact && <Icon name="info" />} {notice.title}</h4><p className={compact ? 'p0-sr-only' : undefined}>{notice.body}</p>
    {related.length > 0 && <ul className="wb-watch-related" aria-label="相关事项">{related.map(task => <li key={task.id}><button disabled={disabled} data-focus-origin={`notice-${notice.id}-${task.id}`} onClick={() => onSelect(task.id)}><span>{task.title}</span><span aria-hidden="true">↗</span></button></li>)}</ul>}
  </div>
}
