import { dayCapacity, minuteOf, routinesForDay, timeOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'

export const DEFAULT_INITIAL_MINUTES = 30
export function onlyRecordRequested(text) {
  if (/(?:先|暂时?|这次)(?:不|别|不要)(?:用)?(?:排|安排)|(?:不用|不要|别)(?:自动)?(?:排时间|排程|安排(?:时间)?|排进日历)/u.test(text)) return true
  for (const match of text.matchAll(/(?:只|仅)(?:先)?(?:记(?:下|录|着|一下)?|存(?:下|着)?|创建)/gu)) {
    // “不要只记下，直接安排” negates record-only, rather than authorizing it.
    if (!/(?:不要|不用|不能|别|并非|不是|不)(?:再|一直)?\s*$/u.test(text.slice(0, match.index))) return true
  }
  return false
}
const nextDay = (date, offset) => {
  const value = new Date(`${date}T12:00:00`)
  return localDay(new Date(value.getFullYear(), value.getMonth(), value.getDate() + offset))
}
const mergeRanges = ranges => {
  const merged = []
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/** Pure placement against the same capacity calculation used by the calendar.
 * No existing block is moved; validation and commit still belong to the store. */
export function initialTaskSchedule({ state, allTasks, tasks, now, idForBlock, bufferMin = 10, windowByTask = new Map() }) {
  const plans = [], allocations = [], unscheduled = []
  const working = { ...state, blocks: [...state.blocks] }
  const today = localDay(now)
  const ordered = [...tasks].filter(task => ['todo', 'doing'].includes(task.status))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.importance - a.importance)
  for (const task of ordered) {
    const estimated = !task.estimateMin
    const totalMin = task.estimateMin ?? DEFAULT_INITIAL_MINUTES
    let remainingMin = totalMin
    const firstDate = task.startAt && task.startAt > today ? task.startAt : today
    const deadline = task.due ? new Date(task.due.length === 10 ? `${nextDay(task.due, 1)}T00:00:00` : task.due).getTime() : Infinity
    const lastDate = task.due ? localDay(new Date(deadline - 1)) : nextDay(firstDate, 6)
    // One year is a bounded search horizon for a far-future explicitly dated
    // task; ordinary new tasks stop at the first available few slots.
    for (let offset = 0; offset < 366 && remainingMin > 0 && plans.length < 64; offset++) {
      const date = nextDay(firstDate, offset)
      if (date > lastDate) break
      const capacity = dayCapacity(working, allTasks, date, now)
      const windowTitle = windowByTask.get(task.id)
      const windows = windowTitle ? routinesForDay(working, date).filter(routine => routine.kind === 'available' && routine.title === windowTitle) : []
      const ranges = windowTitle ? mergeRanges(capacity.remaining.flatMap(range => windows.map(window => ({
        start: Math.max(range.start, minuteOf(window.start)), end: Math.min(range.end, minuteOf(window.end)),
      })).filter(range => range.start < range.end))) : capacity.remaining
      for (const range of ranges) {
        const adjacentBefore = working.blocks.some(block => block.date === date && minuteOf(block.end) === range.start)
        const adjacentAfter = working.blocks.some(block => block.date === date && minuteOf(block.start) === range.end)
        const start = Math.ceil((range.start + (adjacentBefore ? bufferMin : 0)) / 5) * 5
        let end = Math.floor(range.end - (adjacentAfter ? bufferMin : 0))
        const dayStart = new Date(`${date}T00:00:00`).getTime()
        end = Math.min(end, Math.floor((deadline - dayStart) / 60000))
        if (end - start < Math.min(10, remainingMin)) continue
        const duration = Math.min(remainingMin, end - start)
        const block = { id: idForBlock(task.id, plans.length), taskId: task.id, date,
          start: timeOf(start), end: timeOf(start + duration), locked: false }
        plans.push(block); working.blocks.push(block); remainingMin -= duration
        if (!remainingMin || plans.length >= 64) break
      }
    }
    allocations.push({ taskId: task.id, title: task.title, totalMin, scheduledMin: totalMin - remainingMin, estimated })
    if (remainingMin) unscheduled.push({ taskId: task.id, title: task.title, remainingMin,
      reason: `${deadline <= now.getTime() ? '截止时间已过，未安排过去的时段' : `截止前${windowByTask.has(task.id) ? `的「${windowByTask.get(task.id)}」` : ''}没有足够的已知空档，现有安排保持不变`}；还剩 ${remainingMin} 分钟未安排` })
  }
  return { plans, allocations, unscheduled }
}
