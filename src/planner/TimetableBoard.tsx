import { useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { Task } from '../domain/task'
import { localDay, shiftDay } from '../home/agenda'
import { blocksForDay, compactMinutesLabel, dayCapacity, minuteOf, minutesLabel, routinesForDay, timeOf, timetableTimeScale, visibleTimetableRoutines } from './model'
import type { PlanBlock, PlannerState, Routine } from './types'
import { usePeriodMotion } from './usePeriodMotion'

type Props = {
  state: PlannerState; tasks: Task[]; selected: string; anchor: Date; now: Date; direction: number; mode?: 'week' | 'day'
  onSelect: (date: string) => void; onRoutine: (routine: Routine) => void; onTask: (id: string) => void
}
type Slot = { key: string; start: number; end: number; kind: Routine['kind'] | 'plan'; routine?: Routine; block?: PlanBlock; task?: Task }
type PlacedSlot = Slot & { lane: number; lanes: number }
type SlotDensity = 'tiny' | 'short' | 'medium' | 'regular'
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const sourceWeekdays = ['日', '一', '二', '三', '四', '五', '六']
const kindLabels = { class: '课程', available: '空课', break: '休息', plan: '任务安排' }

/** Transparent foreground cards must not reveal the availability labels underneath. */
function availableLabelCoverage(slot: Slot, slots: Slot[], density: SlotDensity, position: (minute: number) => number) {
  const offset = position(slot.start), height = position(slot.end) - offset
  const covered = (top: number, bottom: number) => {
    // An overlapping card in any lane can cover the full-width label.
    return slots.some(other => other.kind !== 'available' && position(other.start) < offset + Math.min(height, bottom) && position(other.end) > offset + Math.max(0, top))
  }
  if (density === 'tiny') {
    const top = Math.max(0, (height - 16) / 2)
    const overlap = covered(top, top + 16)
    return { title: overlap, time: overlap }
  }
  if (density === 'short') {
    const top = Math.max(0, (height - 27) / 2)
    return { title: covered(top, top + 14), time: covered(top + 15, top + 27) }
  }
  const inset = density === 'medium' ? 3 : 4
  return { title: covered(inset, inset + 16), time: covered(height - inset - 13, height - inset) }
}

/** Overlapping fixed lessons/plans share horizontal lanes, preserving every hit target. */
function placeSlots(slots: Slot[]): PlacedSlot[] {
  const available = slots.filter(slot => slot.kind === 'available')
  const foreground = slots.filter(slot => slot.kind !== 'available').sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key))
  const result: PlacedSlot[] = available.map((slot, index) => ({ ...slot, lane: index, lanes: available.length }))
  let group: PlacedSlot[] = [], groupEnd = -1, laneEnds: number[] = []
  const flush = () => {
    for (const item of group) item.lanes = laneEnds.length
    result.push(...group); group = []; laneEnds = []; groupEnd = -1
  }
  for (const slot of foreground) {
    if (slot.start >= groupEnd && group.length) flush()
    let lane = laneEnds.findIndex(end => end <= slot.start)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = slot.end
    group.push({ ...slot, lane, lanes: 1 })
    groupEnd = Math.max(groupEnd, slot.end)
  }
  flush()
  return result
}

export function TimetableBoard({ state, tasks, selected, anchor, now, direction, mode = 'week', onSelect, onRoutine, onTask }: Props) {
  const root = useRef<HTMLDivElement>(null), keyboardDate = useRef<string | null>(null)
  const today = localDay(now), monday = shiftDay(anchor, -((anchor.getDay() + 6) % 7)), weekKey = mode === 'day' ? selected : localDay(monday)
  const dates = mode === 'day' ? [new Date(`${selected}T12:00:00`)] : Array.from({ length: 7 }, (_, i) => shiftDay(monday, i))
  const taskMap = useMemo(() => new Map(tasks.filter(task => !task.deletedAt && task.status !== 'dropped').map(task => [task.id, task])), [tasks])
  const days = dates.map(date => {
    const day = localDay(date), routines = routinesForDay(state, day), blocks = blocksForDay(state, tasks, day)
    const slots: Slot[] = [
      ...visibleTimetableRoutines(routines).map((routine, index) => ({ key: `routine:${routine.id}:${index}`, start: minuteOf(routine.start), end: minuteOf(routine.end), kind: routine.kind, routine })),
      ...blocks.map(block => ({ key: `plan:${block.id}`, start: minuteOf(block.start), end: minuteOf(block.end), kind: 'plan' as const, block, task: taskMap.get(block.taskId) })),
    ].filter(slot => Number.isFinite(slot.start) && Number.isFinite(slot.end) && slot.end > slot.start)
    return { date, day, slots: placeSlots(slots), routines, capacity: dayCapacity(state, tasks, day, now) }
  })
  const startMinute = Math.max(0, Math.floor(Math.min(420, ...days.flatMap(day => day.slots.map(slot => slot.start))) / 60) * 60)
  const endMinute = Math.min(1440, Math.ceil(Math.max(1320, ...days.flatMap(day => day.slots.map(slot => slot.end))) / 60) * 60)
  const duration = endMinute - startMinute, hours = Array.from({ length: duration / 60 + 1 }, (_, index) => startMinute + index * 60)
  const scale = timetableTimeScale(startMinute, endMinute, days.flatMap(day => day.slots))
  const topAt = (minute: number) => `${scale.position(minute) / scale.height * 100}%`
  const currentMinute = now.getHours() * 60 + now.getMinutes()
  const focusDate = days.some(day => day.day === selected) ? selected : weekKey
  const hasContent = days.some(day => day.slots.length)
  const hasAvailability = days.some(day => day.routines.some(routine => routine.kind === 'available'))

  useLayoutEffect(() => {
    if (!keyboardDate.current || keyboardDate.current !== selected) return
    root.current?.querySelector<HTMLButtonElement>(`[data-period-current=true] button[data-date="${selected}"]`)?.focus({ preventScroll: true })
    keyboardDate.current = null
  }, [selected, weekKey])

  const moveDate = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    if (delta === undefined) return
    event.preventDefault()
    const next = localDay(shiftDay(date, delta)); keyboardDate.current = next; onSelect(next)
  }
  const editRoutine = (routine: Routine) => onRoutine(state.routines.find(original => original.id === routine.id) ?? routine)
  const showDayOverride = (day: string) => {
    onSelect(day)
    // A one-day snapshot is not an editor for its original weekly template.
    requestAnimationFrame(() => {
      const summary = root.current?.closest('.planner')?.querySelector<HTMLElement>(`.pl-day-template[data-date="${day}"]`)
      summary?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
      summary?.focus({ preventScroll: true })
    })
  }
  const slotStyle = (slot: PlacedSlot): CSSProperties => {
    // Keep the real time interval as the anchor, with a small visual inset so
    // consecutive tasks and the availability frame remain separate surfaces.
    const inset = slot.kind === 'available' ? 0 : slot.end - slot.start < 20 ? 1 : 2
    return {
      top: `${scale.position(slot.start) + inset}px`,
      height: `${scale.position(slot.end) - scale.position(slot.start) - inset * 2}px`,
      left: slot.kind === 'available' ? '2px' : `calc(${slot.lane / slot.lanes * 100}% + 8px)`,
      width: slot.kind === 'available' ? 'calc(100% - 4px)' : `calc(${100 / slot.lanes}% - 16px)`,
      '--pl-slot-lane': slot.lane, '--pl-slot-lanes': slot.lanes,
    } as CSSProperties
  }

  const frame = <div className="pl-timetable-page" data-period-key={weekKey} style={{ '--pl-timetable-height': `${scale.height}px` } as CSSProperties}>
        <div className="pl-timetable-heading"><span className="pl-timetable-corner" aria-hidden="true"><span>时间</span><small>可支配</small></span>{days.map(({ date, day, capacity, routines }) => {
          const known = routines.some(routine => routine.kind === 'available')
          const availableMinutes = day === today ? capacity.remainingMin : capacity.freeMin
          const capacityLabel = known ? `${day === today ? '今天还可安排' : '可支配'} ${minutesLabel(availableMinutes)}` : '空课待补充'
          const dayOverride = state.dayOverrides?.[day]
          const overrideLabel = dayOverride ? `临时按周${sourceWeekdays[dayOverride.sourceWeekday]}课表` : ''
          return <button key={day} type="button" className="pl-timetable-date" data-date={day} data-today={day === today}
            aria-pressed={day === selected} aria-current={day === today ? 'date' : undefined} tabIndex={day === focusDate ? 0 : -1}
            aria-label={`${date.getMonth() + 1}月${date.getDate()}日，周${weekdays[(date.getDay() + 6) % 7]}，${capacityLabel}${overrideLabel ? `，${overrideLabel}` : ''}`}
            onClick={() => onSelect(day)} onKeyDown={event => moveDate(event, date)}>
            <span>周{weekdays[(date.getDay() + 6) % 7]}{day === today && <small>今天</small>}</span><strong>{date.getDate()}</strong>
            <span className="pl-timetable-capacity" title={state.timetableConfirmed ? capacityLabel : `仅按已知时段 · ${capacityLabel}`}><b>{known ? compactMinutesLabel(availableMinutes) : '待补充'}</b></span>
            {dayOverride && <small className="pl-timetable-override" title={overrideLabel}>调课 · 周{sourceWeekdays[dayOverride.sourceWeekday]}</small>}
          </button>
        })}</div>
        <div className="pl-timetable-grid">
          <div className="pl-timetable-ruler" aria-hidden="true">{hours.map(minute => <span key={minute} style={{ top: topAt(minute) }}>{timeOf(minute)}</span>)}</div>
          {days.map(({ day, slots, capacity }) => <div key={day} className="pl-day-column" data-date={day} data-selected={day === selected} data-today={day === today}>
            <div className="pl-timetable-lines" aria-hidden="true">{hours.map(minute => <span key={minute} style={{ top: topAt(minute) }} />)}</div>
            {slots.map(slot => {
              const title = slot.task?.title ?? slot.routine?.title ?? '任务安排'
              const range = `${timeOf(slot.start)}–${timeOf(slot.end)}`
              const density: SlotDensity = slot.end - slot.start < 20 ? 'tiny' : slot.end - slot.start < 40 ? 'short' : slot.end - slot.start < 60 ? 'medium' : 'regular'
              const isAvailable = slot.kind === 'available'
              const coverage = isAvailable ? availableLabelCoverage(slot, slots, density, scale.position) : null
              const dayOverride = slot.routine ? state.dayOverrides?.[day] : undefined
              const activate = () => slot.routine ? dayOverride ? showDayOverride(day) : editRoutine(slot.routine) : slot.task && onTask(slot.task.id)
              const label = `${kindLabels[slot.kind]}，${title}，${range}${slot.routine?.location ? `，${slot.routine.location}` : ''}`
              const actionLabel = dayOverride ? `${label}，临时按周${sourceWeekdays[dayOverride.sourceWeekday]}课表，查看当日调课说明` : `${isAvailable ? '编辑' : ''}${label}`
              return isAvailable ? <button key={slot.key} type="button" className="pl-slot" data-kind="available" data-density={density} data-override={Boolean(dayOverride)} data-title-covered={coverage?.title} data-time-covered={coverage?.time} style={slotStyle(slot)} onClick={activate} aria-label={actionLabel} title={actionLabel}>
                <strong>{title}</strong><small className="pl-slot-time">{range}</small>
              </button> : <button key={slot.key} type="button" className="pl-slot" data-kind={slot.kind} data-density={density} data-done={slot.task?.status === 'done'}
                data-override={Boolean(dayOverride)} data-conflict={Boolean(slot.block && capacity.conflicts.includes(slot.block.id))} style={slotStyle(slot)} onClick={activate} aria-label={actionLabel} title={actionLabel}>
                <small className="pl-slot-time">{range}</small><strong>{title}</strong>{slot.routine?.location && <small className="pl-slot-location">{slot.routine.location}</small>}
                {slot.block?.locked && <span className="pl-slot-locked" aria-label="时间已锁定">◇</span>}
              </button>
            })}
            {day === today && currentMinute >= startMinute && currentMinute <= endMinute && <div className="pl-now-line" style={{ top: topAt(currentMinute) }} aria-label={`现在 ${timeOf(currentMinute)}`}><span /></div>}
          </div>)}
        </div>
      </div>
  const motion = usePeriodMotion(weekKey, `timetable-${mode}`, frame, direction)
  const current = <div key="current" className="pl-period-frame" data-period-current="true">{frame}</div>
  const previous = motion.previous && <div key="previous" className="pl-period-frame" data-period-current="false" inert aria-hidden="true">{motion.previous}</div>
  return <div ref={root} className="pl-timetable-board" data-mode={mode}>
    <div className="pl-timetable-scroll">
      <div className="pl-period-window" data-moving={motion.moving} data-direction={motion.direction}>
        <div key={motion.revision} className="pl-period-track" onAnimationEnd={motion.finish}>
          {motion.direction === 'previous' ? <>{current}{previous}</> : <>{previous}{current}</>}
        </div>
      </div>
    </div>
    <footer className="pl-timetable-footer">
      {!hasContent ? <p>这{mode === 'day' ? '一天' : '一周'}还没有课程或安排，可以先添加固定课程与空课</p>
        : !hasAvailability ? <p>已显示课程与安排，添加空课后才能计算可支配时间</p>
          : !state.timetableConfirmed ? <p>仅按已知时段计算空课，未填写的时间不默认空闲</p>
            : <p>{days.some(({ day }) => state.dayOverrides?.[day]) ? '点击临时课节查看调课说明，常规课程和空课仍可编辑' : '点击课程或空课编辑，点击任务查看安排'}</p>}
    </footer>
  </div>
}
