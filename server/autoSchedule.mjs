import { dayCapacity, minuteOf, routinesForDay, timeOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'

export const DEFAULT_INITIAL_MINUTES = 30
export const MIN_INITIAL_SEGMENT_MINUTES = 15
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

function occurrenceSlot(task, state, allTasks, now, bufferMin) {
  const { date, preferredWindow, placement, allowFallback } = task.occurrence
  const minutes = task.estimateMin
  if (date < localDay(now)) return null
  const capacity = dayCapacity(state, allTasks, date, now)
  const windows = routinesForDay(state, date).filter(routine => routine.kind === 'available' && routine.title === preferredWindow)
    .map(window => ({ start: minuteOf(window.start), end: minuteOf(window.end) }))
  const dayStart = new Date(`${date}T00:00:00`).getTime()
  const deadline = task.due ? new Date(task.due.length === 10 ? `${nextDay(task.due, 1)}T00:00:00` : task.due).getTime() : Infinity
  const available = capacity.remaining.map(range => ({
    start: Math.ceil((range.start + (state.blocks.some(block => block.date === date && minuteOf(block.end) === range.start) ? bufferMin : 0)) / 5) * 5,
    end: Math.min(Math.floor(range.end - (state.blocks.some(block => block.date === date && minuteOf(block.start) === range.end) ? bufferMin : 0)),
      Math.floor((deadline - dayStart) / 60000)),
  })).filter(range => range.end - range.start >= minutes)
  const withinWindow = preferredWindow ? mergeRanges(available.flatMap(range => windows.map(window => ({
    start: Math.max(range.start, window.start), end: Math.min(range.end, window.end),
  })).filter(range => range.start < range.end))).filter(range => range.end - range.start >= minutes) : available
  const pickEdge = ranges => placement === 'end' ? ranges.at(-1) && { start: ranges.at(-1).end - minutes, end: ranges.at(-1).end }
    : ranges[0] && { start: ranges[0].start, end: ranges[0].start + minutes }
  const preferred = pickEdge(withinWindow)
  if (preferred) return { date, ...preferred, fallback: false }
  if (!allowFallback || !available.length) return null
  // A preferred window occupied by another event can fall back to the nearest
  // complete same-day slot, never to tomorrow or several fragments.
  const anchor = windows.length ? placement === 'end' ? Math.max(...windows.map(window => window.end)) - minutes
    : Math.min(...windows.map(window => window.start)) : null
  const alternative = anchor === null ? pickEdge(available) : available.map(range => {
    const start = Math.max(range.start, Math.min(anchor, range.end - minutes))
    return { start, end: start + minutes }
  }).sort((a, b) => Math.abs(a.start - anchor) - Math.abs(b.start - anchor) || a.start - b.start)[0]
  return alternative ? { date, ...alternative, fallback: Boolean(preferredWindow) } : null
}

/** Pure placement against the same capacity calculation used by the calendar.
 * No existing block is moved; validation and commit still belong to the store. */
export function initialTaskSchedule({ state, allTasks, tasks, now, idForBlock, bufferMin = 10, windowByTask = new Map(), dateByTask = new Map() }) {
  const plans = [], allocations = [], unscheduled = []
  const working = { ...state, blocks: [...state.blocks] }
  const today = localDay(now)
  const ordered = [...tasks].filter(task => ['todo', 'doing'].includes(task.status) && !task.freeTimeGoalId)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.importance - a.importance)
  for (const task of ordered) {
    const estimated = !task.estimateMin
    const totalMin = task.estimateMin ?? DEFAULT_INITIAL_MINUTES
    if (task.occurrence) {
      const slot = occurrenceSlot(task, working, allTasks, now, bufferMin)
      if (slot && plans.length < 64) {
        const block = { id: idForBlock(task.id, plans.length), taskId: task.id, date: task.occurrence.date,
          start: timeOf(slot.start), end: timeOf(slot.end), locked: false }
        plans.push(block); working.blocks.push(block)
        allocations.push({ taskId: task.id, title: task.title, date: task.occurrence.date, totalMin, scheduledMin: totalMin, estimated,
          ...(task.occurrence.preferredWindow ? { preferredWindow: task.occurrence.preferredWindow, fallback: slot.fallback } : {}) })
      } else {
        allocations.push({ taskId: task.id, title: task.title, date: task.occurrence.date, totalMin, scheduledMin: 0, estimated })
        unscheduled.push({ taskId: task.id, title: task.title, date: task.occurrence.date, remainingMin: totalMin,
          reason: `${task.occurrence.date} ${task.occurrence.preferredWindow && !task.occurrence.allowFallback ? `的「${task.occurrence.preferredWindow}」` : '当天'}没有可用的完整 ${totalMin} 分钟空档；保留当天实例，不拆段、不挪到其他日期` })
      }
      continue
    }
    let remainingMin = totalMin
    const exactDate = dateByTask.get(task.id)
    const firstDate = exactDate ?? (task.startAt && task.startAt > today ? task.startAt : today)
    const deadline = task.due ? new Date(task.due.length === 10 ? `${nextDay(task.due, 1)}T00:00:00` : task.due).getTime() : Infinity
    const lastDate = exactDate ?? (task.due ? localDay(new Date(deadline - 1)) : nextDay(firstDate, 6))
    // Prefer one continuous slot before splitting. Keep the earlier candidates
    // so a task with no complete slot can still use meaningful work sessions.
    const candidates = []
    let completeSlot
    // One year is a bounded search horizon for a far-future explicitly dated task.
    for (let offset = 0; offset < 366 && !completeSlot && plans.length < 64; offset++) {
      const date = nextDay(firstDate, offset)
      if (date > lastDate) break
      if (exactDate && (date < today || (task.startAt && date < task.startAt))) continue
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
        if (end - start < Math.min(MIN_INITIAL_SEGMENT_MINUTES, totalMin)) continue
        const slot = { date, start, end }
        candidates.push(slot)
        if (end - start >= totalMin) { completeSlot = slot; break }
      }
    }
    // A requested day still requires a complete slot. An explicit short task
    // is also kept whole; it is not permission to make a tiny tail on long work.
    const selected = completeSlot ? [completeSlot] : exactDate ? [] : candidates
    for (const slot of selected) {
      if (remainingMin <= 0 || plans.length >= 64) break
      let duration = Math.min(remainingMin, slot.end - slot.start)
      if (duration < remainingMin && remainingMin - duration < MIN_INITIAL_SEGMENT_MINUTES) {
        duration = remainingMin - MIN_INITIAL_SEGMENT_MINUTES
      }
      if (duration < Math.min(MIN_INITIAL_SEGMENT_MINUTES, totalMin)) continue
      const block = { id: idForBlock(task.id, plans.length), taskId: task.id, date: slot.date,
        start: timeOf(slot.start), end: timeOf(slot.start + duration), locked: false }
      plans.push(block); working.blocks.push(block); remainingMin -= duration
    }
    allocations.push({ taskId: task.id, title: task.title, ...(exactDate ? { date: exactDate } : {}), totalMin, scheduledMin: totalMin - remainingMin, estimated })
    if (remainingMin) unscheduled.push({ taskId: task.id, title: task.title, ...(exactDate ? { date: exactDate } : {}), remainingMin,
      reason: exactDate
        ? `${exactDate}${windowByTask.has(task.id) ? ` 的「${windowByTask.get(task.id)}」` : ' 当天'}没有可用的完整 ${totalMin} 分钟空档；未拆分或挪到其他日期，现有安排保持不变`
        : `${deadline <= now.getTime() ? '截止时间已过，未安排过去的时段' : `截止前${windowByTask.has(task.id) ? `的「${windowByTask.get(task.id)}」` : ''}没有足够的可用连续空档${totalMin > MIN_INITIAL_SEGMENT_MINUTES ? `（拆分时每段至少 ${MIN_INITIAL_SEGMENT_MINUTES} 分钟）` : ''}，现有安排保持不变`}；还剩 ${remainingMin} 分钟未安排` })
  }
  return { plans, allocations, unscheduled }
}
