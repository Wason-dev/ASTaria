import { useState } from 'react'
import type { Task } from '../domain/task'
import { TaskCardStack } from '../ui/TaskCardStack'
import { agendaDate, localDay } from '../home/agenda'
import { blocksForDay, carryItems, dayCapacity, minutesLabel, timeOf } from './model'
import { EMPTY_DETAILS } from './PlannerDialogs'
import { PlannerIcon as Icon } from './PlannerIcon'
import type { DayEvent, PlannerAction, PlannerState } from './types'

type Props = {
  view: 'calendar' | 'timetable'; selected: string; anchor: Date; now: Date
  state: PlannerState; tasks: Task[]; saving: boolean; error: string
  onMoveDay: (amount: number) => void; onTask: (id: string) => void; onCreate: () => void
  onDayEvent: (event: DayEvent) => void
  onAct: (action: PlannerAction, notice?: string) => Promise<void>
}
const fullDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** A horizontal briefing whose sections grow naturally instead of nesting scroll areas. */
export function PlannerOverview({ view, selected, anchor, now, state, tasks, saving, error, onMoveDay, onTask, onDayEvent, onCreate, onAct }: Props) {
  const today = localDay(now)
  const dayOverride = state.dayOverrides?.[selected]
  const overrideLabel = dayOverride ? `临时按周${['日', '一', '二', '三', '四', '五', '六'][dayOverride.sourceWeekday]}课表` : ''
  const blocks = blocksForDay(state, tasks, selected)
  const capacity = dayCapacity(state, tasks, selected, now)
  const carry = carryItems(state, tasks, selected)
  const tasksForDay = tasks.filter(task => !task.deletedAt && task.status !== 'dropped' && (blocks.some(block => block.taskId === task.id)
    || (!state.blocks.some(block => block.taskId === task.id) && task.startAt && agendaDate(task.startAt) && localDay(agendaDate(task.startAt)!) === selected)
    || (task.due && agendaDate(task.due) && localDay(agendaDate(task.due)!) === selected)))
  const eventsForDay = (state.dayEvents ?? []).filter(event => event.date === selected)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'zh-CN'))
  const entryCount = tasksForDay.length + eventsForDay.length
  const preparations = tasksForDay.filter(task => state.details[task.id]?.preparation)
  const submissions = tasksForDay.filter(task => state.details[task.id]?.needsSubmission)
  const undated = tasks.filter(task => !task.deletedAt && (task.status === 'todo' || task.status === 'doing') && !state.blocks.some(block => block.taskId === task.id) && !(task.startAt?.includes('T') && task.estimateMin))
  const monthDue = tasks.filter(task => !task.deletedAt && task.status !== 'dropped' && task.due
    && agendaDate(task.due)?.getFullYear() === anchor.getFullYear() && agendaDate(task.due)?.getMonth() === anchor.getMonth())
    .sort((a, b) => a.due!.localeCompare(b.due!))
  const taskMeta = (task: Task) => {
    const due = agendaDate(task.due)
    const planned = blocks.filter(block => block.taskId === task.id).map(block => `${block.start}–${block.end}`).join(' · ')
    return [planned, due && localDay(due) === selected ? `当天截止${task.due?.includes('T') ? ` ${clock.format(due)}` : ''}` : '', task.status === 'done' ? '已完成' : ''].filter(Boolean).join(' · ') || '时间待定'
  }

  return <div className="pl-overview-grid" data-view={view}>
    <section className="pl-overview-summary">
      <header className={`pl-day-header ${view === 'calendar' ? 'pl-calendar-summary-header' : ''}`}>
        <div><span className="pl-eyebrow">{selected === today ? '今天' : '这一天'}</span><h3 key={selected}>{fullDate.format(new Date(`${selected}T12:00:00`))}</h3>{dayOverride && <div className="pl-day-template" data-date={selected} tabIndex={-1} aria-label={`${overrideLabel}，仅这一天生效`}><span title="仅这一天生效，每周课表保持不变">{overrideLabel}</span><button type="button" className="pl-text-button" disabled={saving} onClick={() => void onAct({ type: 'remove-day-template', date: selected }, '已恢复这一天原来的课表')} aria-label="恢复这一天原来的课表"><Icon name="undo" /><span>恢复原课表</span></button></div>}</div>
        <div className="pl-day-arrows"><button className="pl-icon-button" aria-label="前一天" onClick={() => onMoveDay(-1)}><Icon name="left" /></button><button className="pl-icon-button" aria-label="后一天" onClick={() => onMoveDay(1)}><Icon name="right" /></button></div>
      </header>
      {view === 'timetable' ? <section className="pl-capacity pl-overview-date-content" key={selected}>
        <div className="pl-capacity-hero"><span>{selected === today ? '从现在起可支配' : '可支配时间'}</span><strong>{minutesLabel(selected === today ? capacity.remainingMin : capacity.freeMin)}</strong><small>{selected === today ? `全天空闲 ${minutesLabel(capacity.freeMin)}` : `最长空档 ${minutesLabel(capacity.longestMin)}`}</small></div>
        <div className="pl-capacity-detail"><span>可用 {minutesLabel(capacity.totalMin)}</span><span>已排 {minutesLabel(capacity.scheduledMin)}</span></div>
        <div className="pl-free-slots">{(selected === today ? capacity.remaining : capacity.free).slice(0, 3).map(slot => <span key={slot.start}>{timeOf(slot.start)}–{timeOf(slot.end)}</span>)}{(selected === today ? capacity.remaining : capacity.free).length > 3 && <span>另 {(selected === today ? capacity.remaining : capacity.free).length - 3} 段</span>}</div>
        {capacity.unestimatedCount > 0 && <p className="pl-warning">{capacity.unestimatedCount} 项未估时，暂未扣除</p>}
        {capacity.conflicts.length > 0 && <p className="pl-warning">{capacity.conflicts.length} 项时间冲突，需核对</p>}
        {!capacity.totalMin && <p className="pl-muted">添加空课后显示可用时间</p>}
      </section> : <section className="pl-calendar-summary-focus pl-overview-date-content" key={selected}><strong>{entryCount ? `${entryCount} 项事项` : '这天还没有事项'}</strong><small>{tasksForDay.filter(task => task.status === 'done').length} 项已完成 · {tasksForDay.filter(task => { const due = agendaDate(task.due); return due && localDay(due) === selected }).length} 项当天截止</small></section>}
    </section>
    <section className="pl-overview-tasks">
      <header className="pl-overview-heading"><h4>当天事项 <small>{entryCount}</small></h4><button className="pl-add-inline" onClick={onCreate}><Icon name="plus" />记录事项</button></header>
      <div className="pl-overview-list pl-overview-date-content" key={selected}><div className="pl-overview-task-grid">
        {tasksForDay.map(task => <button key={`task:${task.id}`} className={view === 'calendar' ? 'pl-calendar-summary-task' : 'pl-day-task'} data-done={task.status === 'done'} onClick={() => onTask(task.id)}><span className="pl-overview-task-copy"><strong>{task.title}</strong><small>{taskMeta(task)}</small></span></button>)}
        {eventsForDay.map(event => <button key={`event:${event.id}`} type="button" className={view === 'calendar' ? 'pl-calendar-summary-task' : 'pl-day-task'} aria-label={`编辑单日活动，${event.title}，${event.date}，${event.start}–${event.end}${event.location ? `，${event.location}` : ''}`} onClick={() => onDayEvent(event)}><span className="pl-overview-task-copy"><strong>{event.title}</strong><small>{event.date} · {event.start}–{event.end}{event.location && ` · ${event.location}`}</small></span></button>)}
      </div>{!entryCount && <p className="pl-muted">这天还没有活动、计划或截止事项</p>}</div>
    </section>
    <section className="pl-overview-notes">
      {view === 'calendar' ? <MonthDeadlines key={`${anchor.getFullYear()}-${anchor.getMonth()}`} tasks={monthDue} onTask={onTask} /> : <>
      <header className="pl-overview-heading"><h4>出门与准备 <small>{carry.filter(item => item.checked).length}/{carry.length}</small></h4></header>
      <div className="pl-overview-list pl-overview-date-content" key={selected}>
        {carry.length ? <ul className="pl-checklist">{carry.map(item => <li key={item.key}><button className="pl-check" aria-label={`${item.checked ? '取消确认' : '确认已带'}${item.label}`} aria-pressed={item.checked} disabled={saving} onClick={() => void onAct({ type: 'check-item', date: selected, key: item.key, checked: !item.checked })}>{item.checked && <Icon name="check" />}</button><div><strong>{item.label}{item.suggested && <em>建议</em>}</strong><small>{item.sources.join(' · ')}</small></div></li>)}</ul> : <p className="pl-muted">还没有明确要带的物品</p>}
        {preparations.map(task => <button className="pl-preparation" key={task.id} onClick={() => onTask(task.id)}><strong>{state.details[task.id].preparation}</strong><small>{task.title}</small></button>)}
        {submissions.map(task => { const details = state.details[task.id] ?? EMPTY_DETAILS; return <div className="pl-submission-row" key={task.id}><button className="pl-text-button" onClick={() => onTask(task.id)}><strong>{task.title}</strong><small>{details.submittedAt ? '已提交' : task.status === 'done' ? '已做完 · 还没确认提交' : '提交待确认'}</small></button><button className="pl-icon-button" disabled={saving} title={details.submittedAt ? '撤回提交确认' : '确认已提交'} aria-label={`${task.title}，${details.submittedAt ? '撤回提交确认' : '确认已提交'}`} onClick={() => void onAct({ type: 'save-details', taskId: task.id, details: { ...details, submittedAt: details.submittedAt ? null : new Date().toISOString() } }, details.submittedAt ? '已撤回提交确认' : '已确认提交')}><Icon name={details.submittedAt ? 'undo' : 'check'} /></button></div> })}
      </div>
      </>}
      {error && <p className="pl-error" role="alert">{error}</p>}
    </section>
    {view === 'timetable' && <section className="pl-overview-unscheduled" aria-labelledby="pl-unscheduled-heading">
      <header className="pl-overview-heading"><h4 id="pl-unscheduled-heading">待安排 <small>{undated.length}</small></h4></header>
      <TaskCardStack compact label="待安排" items={undated.map(task => ({ id: task.id, title: task.title, meta: task.estimateMin ? `${task.estimateMin} 分钟` : '用时待估' }))} onOpen={onTask} empty="暂无待安排事项" />
    </section>}
  </div>
}

function MonthDeadlines({ tasks, onTask }: { tasks: Task[]; onTask: (id: string) => void }) {
  const pending = tasks.filter(task => task.status !== 'done')
  const completed = tasks.filter(task => task.status === 'done')
  return <details className="pl-month-deadlines">
    <summary className="pl-month-deadline-toggle"><span>本月截止 <small>{tasks.length}</small></span><Icon name="right" /></summary>
    {!tasks.length ? <p className="pl-muted">这个月还没有截止事项</p> : <div className="pl-month-deadline-content">
      <p className="pl-muted">{pending.length} 项待完成 · {completed.length} 项已完成</p>
      {pending.length > 0 && <MonthDeadlineList tasks={pending} onTask={onTask} label="待完成截止事项" />}
      {completed.length > 0 && <details className="pl-month-deadlines-completed">
        <summary className="pl-month-deadline-toggle"><span>已完成 <small>{completed.length}</small></span><Icon name="right" /></summary>
        <MonthDeadlineList tasks={completed} onTask={onTask} label="已完成截止事项" />
      </details>}
    </div>}
  </details>
}

function MonthDeadlineList({ tasks, onTask, label }: { tasks: Task[]; onTask: (id: string) => void; label: string }) {
  const [page, setPage] = useState(0)
  const pageCount = Math.ceil(tasks.length / 6)
  const currentPage = Math.min(page, Math.max(0, pageCount - 1))
  return <div aria-label={label}>
    {tasks.slice(currentPage * 6, currentPage * 6 + 6).map(task => <button type="button" key={task.id} className="pl-month-deadline" data-done={task.status === 'done'} onClick={() => onTask(task.id)} title={task.title}><time dateTime={task.due!}>{agendaDate(task.due)!.getMonth()+1}/{agendaDate(task.due)!.getDate()}</time><span>{task.title}</span>{task.status === 'done' && <Icon name="check" />}</button>)}
    {pageCount > 1 && <div className="pl-month-deadline-pages" role="group" aria-label={`${label}分页`}>
      <button type="button" disabled={currentPage === 0} aria-label={`上一页${label}`} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <span role="status">{currentPage + 1} / {pageCount}</span>
      <button type="button" disabled={currentPage + 1 === pageCount} aria-label={`下一页${label}`} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </div>}
  </div>
}
