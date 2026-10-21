import { useId } from 'react'
import { DEADLINE_TIME_SHORTCUTS } from './deadlineShortcuts'
import './receipt-deadline.css'

/** Shared date/time controls used by receipt and Horizon deadline edits. */
export function DeadlineFields({ date, time, busy, onDate, onTime, selectedDate = false }: {
  date: string; time: string; busy: boolean; onDate: (value: string) => void; onTime: (value: string) => void; selectedDate?: boolean
}) {
  const id = useId()
  return <>
    <div className="xixi-deadline-fields">{selectedDate
      ? <div className="xixi-deadline-selected"><span>截止日期</span><strong>{date.replaceAll('-', ' / ')}</strong></div>
      : <label htmlFor={`${id}-date`}>截止日期<input id={`${id}-date`} type="date" required value={date} disabled={busy} onChange={event => onDate(event.target.value)} /></label>}
      <label htmlFor={`${id}-time`}>时刻 · 可选<input id={`${id}-time`} type={selectedDate ? 'text' : 'time'} placeholder="HH:MM" maxLength={5} pattern={selectedDate ? '([01][0-9]|2[0-3]):[0-5][0-9]' : undefined} title="24 小时时刻，例如 20:00" value={time} disabled={busy} onChange={event => onTime(event.target.value)} /></label>
    </div>
    <div className="xixi-deadline-times" role="group" aria-label="快捷选择截止时刻">{[...DEADLINE_TIME_SHORTCUTS, ''].map(value => <button type="button" key={value || 'all-day'} disabled={busy} aria-pressed={time === value} onClick={() => onTime(value)}>{value || '全天'}</button>)}</div>
  </>
}
