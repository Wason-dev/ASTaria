import { useId, useMemo, useState } from 'react'
import { agendaDate } from '../home/agenda'
import { PlannerDialog } from './PlannerDialogs'
import { PlannerIcon as Icon } from './PlannerIcon'
import type { Routine, RoutineKind } from './types'
import './routine-browser.css'

type Props = {
  routines: readonly Routine[]
  selectedDate: string
  onClose: () => void
  onEdit: (routine: Routine) => void
  onAdd: (weekday: number) => void
}

const DAYS = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const GROUPS: Record<RoutineKind, { title: string; label: string }> = {
  available: { title: '可安排时段', label: '可安排' },
  class: { title: '课程与固定占用', label: '固定占用' },
  break: { title: '休息与通勤', label: '休息' },
}

export function RoutineBrowser({ routines, selectedDate, onClose, onEdit, onAdd }: Props) {
  const [weekday, setWeekday] = useState(() => agendaDate(selectedDate)?.getDay() ?? new Date().getDay())
  const [destination, setDestination] = useState<Routine | 'new' | null>(null)
  const titleId = useId()
  const byDay = useMemo(() => DAYS.map(day => ({
    day,
    routines: routines.filter(routine => routine.weekdays.includes(day))
      .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'zh-CN')),
  })), [routines])
  const selected = byDay.find(day => day.day === weekday)!.routines
  const disabledCount = selected.filter(routine => !routine.enabled).length
  const leave = () => {
    if (destination === 'new') onAdd(weekday)
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
          <span className="pl-routine-copy"><strong>{routine.title}</strong><span><small>{GROUPS[kind].label}</small>{routine.location && <small>{routine.location}</small>}{!routine.enabled && <small className="pl-routine-disabled">已停用</small>}</span></span>
          <span className="pl-routine-edit" aria-hidden="true"><Icon name="edit" /></span>
        </button>
      </li>)}</ul> : <p className="pl-routine-group-empty">这一天没有{GROUPS[kind].title}</p>}
    </details>
  }

  return <PlannerDialog title="每周安排" className="pl-routine-browser" onClose={leave} closeRequested={Boolean(destination)}>
    <div className="pl-routine-browser-toolbar"><span>{routines.length} 项每周安排 · 点选时段即可修改</span><button type="button" className="pl-primary" disabled={Boolean(destination)} onClick={() => setDestination('new')}><Icon name="plus" />添加时段</button></div>
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
