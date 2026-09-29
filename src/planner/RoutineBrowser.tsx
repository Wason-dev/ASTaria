import { weekCycleLabel, weekStart } from './weekCycle'
import { useEffect, useId, useMemo, useState } from 'react'
import { agendaDate } from '../home/agenda'
import { PlannerDialog } from './PlannerDialogs'
import { PlannerIcon as Icon } from './PlannerIcon'
import type { Routine, RoutineKind } from './types'
import './routine-browser.css'

type Props = {
  routines: readonly Routine[]
  selectedDate: string
  firstWeekMonday?: string
  onSaveFirstWeek: (date: string) => Promise<void>
  onClose: () => void
  onEdit: (routine: Routine) => void
  onAdd: (weekday: number, cycle: 'weekly' | 'odd' | 'even') => void
}

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const GROUPS: Record<RoutineKind, { title: string; label: string }> = {
  available: { title: '可安排时段', label: '可安排' },
  class: { title: '课程与固定占用', label: '固定占用' },
  break: { title: '休息与通勤', label: '休息' },
}

export function RoutineBrowser({ routines, selectedDate, firstWeekMonday, onSaveFirstWeek, onClose, onEdit, onAdd }: Props) {
  const [weekday, setWeekday] = useState(() => agendaDate(selectedDate)?.getDay() ?? new Date().getDay())
  const [destination, setDestination] = useState<Routine | 'new' | null>(null)
  const titleId = useId()
  const [cycle, setCycle] = useState<'all' | 'odd' | 'even'>('all')
  const [firstWeek, setFirstWeek] = useState(firstWeekMonday ?? routines.find(item => item.weekAnchor)?.weekAnchor ?? weekStart(selectedDate) ?? '')
  const [savingWeek, setSavingWeek] = useState(false), [weekError, setWeekError] = useState('')
  useEffect(() => { if (firstWeekMonday) setFirstWeek(firstWeekMonday) }, [firstWeekMonday])
  const saveWeek = async () => {
    if (savingWeek) return
    if (weekStart(firstWeek) !== firstWeek) { setWeekError('请选择第1周的周一'); return }
    setSavingWeek(true); setWeekError('')
    try { await onSaveFirstWeek(firstWeek) }
    catch (reason) { setWeekError(reason instanceof Error ? reason.message : '首周设置未保存，请重试') }
    finally { setSavingWeek(false) }
  }
  const byDay = useMemo(() => DAYS.map(day => ({
    day,
    routines: routines.filter(routine => routine.weekdays.includes(day) && (cycle === 'all' || !routine.weekCycle || routine.weekCycle === 'weekly' || routine.weekCycle === cycle))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'zh-CN')),
  })), [routines, cycle])
  const selected = byDay.find(day => day.day === weekday)!.routines
  const disabledCount = selected.filter(routine => !routine.enabled).length
  const leave = () => {
    if (destination === 'new') onAdd(weekday, cycle === 'all' ? 'weekly' : cycle)
    else if (destination) onEdit(destination)
    else onClose()
  }
  const group = (kind: RoutineKind) => {
    const entries = selected.filter(routine => routine.kind === kind)
    return <details key={`${weekday}-${kind}`} className="pl-routine-group" data-kind={kind} open={kind !== 'break'}>
      <summary><span>{GROUPS[kind].title}</span><small>{entries.length}</small><span className="pl-routine-disclosure" aria-hidden="true">⌄</span></summary>
      {entries.length ? <ul>{entries.map(routine => <li key={routine.id}>
        <button type="button" className="pl-routine-entry" data-enabled={routine.enabled} disabled={Boolean(destination)}
          aria-label={`编辑${routine.title}，${routine.start}至${routine.end}，${GROUPS[kind].label}${routine.enabled ? '' : '，已停用'}`}
          onClick={() => setDestination(routine)}>
          <span className="pl-routine-time"><time>{routine.start}</time><time>{routine.end}</time></span>
          <span className="pl-routine-copy"><strong>{routine.title}</strong><span><small>{GROUPS[kind].label}</small><small>{weekCycleLabel(routine)}{routine.weekAnchor ? ` · 第1周 ${routine.weekAnchor}` : ''}</small>{routine.location && <small>{routine.location}</small>}{!routine.enabled && <small className="pl-routine-disabled">已停用</small>}</span></span>
          <span className="pl-routine-edit" aria-hidden="true"><Icon name="edit" /></span>
        </button>
      </li>)}</ul> : <p className="pl-routine-group-empty">这一天没有{GROUPS[kind].title}</p>}
    </details>
  }

  return <PlannerDialog title="每周安排" className="pl-routine-browser" onClose={leave} busy={savingWeek} closeRequested={Boolean(destination)}>
    <div className="pl-routine-browser-toolbar"><span>{routines.length} 项每周安排 · 点选时段即可修改</span><button type="button" className="pl-primary" disabled={Boolean(destination)} onClick={() => setDestination('new')}><Icon name="plus" />添加时段</button></div>
    <div className="pl-routine-week-controls"><div className="pl-segment" role="group" aria-label="每周安排周次">{(['all', 'odd', 'even'] as const).map(value => <button type="button" key={value} aria-pressed={cycle === value} onClick={() => setCycle(value)}>{value === 'all' ? '全部' : value === 'odd' ? '单周' : '双周'}</button>)}</div><form onSubmit={event => { event.preventDefault(); void saveWeek() }}><label>共用第1周周一<input type="date" aria-label="共用第1周周一" required value={firstWeek} disabled={savingWeek} onChange={event => setFirstWeek(event.target.value)} /></label><button className="pl-secondary" type="submit" disabled={savingWeek || !firstWeek || firstWeek === firstWeekMonday}>{savingWeek ? '保存中' : '保存首周'}</button></form></div>
    <p className="pl-muted">每周时段在单双周都显示。切换只用于查看；保存首周会统一单双周规则，不移动已排任务。{!firstWeekMonday && ' 当前尚未设置共用首周，已有时段暂按各自首周计算。'}</p>
    {weekError && <p className="pl-error" role="alert">{weekError}</p>}
    <div className="pl-routine-browser-layout">
      <nav className="pl-routine-days" aria-label="选择星期">{byDay.map(({ day, routines: entries }) => <button key={day} type="button" aria-pressed={weekday === day} aria-controls={titleId} disabled={Boolean(destination)}
        aria-label={`星期${DAY_NAMES[day]}，${entries.length} 项安排`} autoFocus={day === weekday} onClick={() => setWeekday(day)}>
        <span><span className="pl-routine-day-prefix">星期</span>{DAY_NAMES[day]}</span><small>{entries.length}</small>
      </button>)}</nav>
      <section className="pl-routine-day-content" aria-labelledby={titleId}>
        <header className="pl-routine-day-heading"><h3 id={titleId}>星期{DAY_NAMES[weekday]}</h3><span>{selected.length} 项安排{disabledCount > 0 && ` · ${disabledCount} 项已停用`}</span></header>
        <div className="pl-routine-group-columns"><div>{group('available')}{group('break')}</div><div>{group('class')}</div></div>
      </section>
    </div>
  </PlannerDialog>
}
