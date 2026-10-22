import { blocksForDay, dayCapacity, minuteOf, routinesForDay, timeOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'
import { taskTimingBounds, orderByTaskRelations } from './taskTiming.mjs'

export const DEFAULT_INITIAL_MINUTES = 30
export const MIN_INITIAL_SEGMENT_MINUTES = 15
// Evidence is a bounded explanation payload: it never changes what is scheduled.
const MAX_EVIDENCE_DAYS = 14
const MAX_ALTERNATIVES = 3
export function onlyRecordRequested(text) {
  if (/(?:先|暂时?|这次)(?:不|别|不要)(?:用)?(?:排|安排)|(?:不用|不要|别)(?:自动)?(?:排时间|排程|安排(?:时间)?|排进日历)/u.test(text)) return true
  if (/(?:不|别|不要|不用)(?:再|自动)?(?:占用?|预留)(?:任何|日历|日程)?时间|不排(?:进)?(?:日历|日程)/u.test(text)) return true
  for (const match of text.matchAll(/(?:只|仅)(?:先)?(?:记(?:下|录|着|一下)?|存(?:下|着)?|创建)/gu)) {
    // “不要只记下，直接安排” negates record-only, rather than authorizing it.
    if (!/(?:不要|不用|不能|别|并非|不是|不)(?:再|一直)?\s*$/u.test(text.slice(0, match.index))) return true
  }
  return false
}

/** Tool intent handles arbitrary reminders. This narrow fallback also protects
 * obvious date markers when an older/model-generated call omits that intent.
 * A work deadline alone never makes ordinary homework a record-only item. */
export function recordOnlyTaskRequested(text, draft, hasExplicitSlot = false) {
  if (draft.kind === 'reminder' || onlyRecordRequested(text) || draft.scheduleMode === 'record-only') return true
  if (draft.kind === 'task') return false
  const title = String(draft.title ?? '')
  const work = /复习|备考|预习|练习|做题|刷题|背诵|阅读|整理|撰写|准备|填写|提交|交付|购买|打印|领取|制作|缴费|申请|试卷|卷子|真题|错题|习题|报名(?!截止|到期)/u.test(title)
  const marker = /月考|周考|期中考|期末考|考试|测验|生日|纪念日|(?:截止|到期)(?:日期|时间|日|提醒)?\s*$/u.test(title)
  return marker && !work && !hasExplicitSlot
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
const dayStartOf = date => new Date(`${date}T00:00:00`).getTime()
const taskDeadline = task => task.due
  ? new Date(task.due.length === 10 ? `${nextDay(task.due, 1)}T00:00:00` : task.due).getTime()
  : Infinity
const segmentFloor = totalMin => Math.min(MIN_INITIAL_SEGMENT_MINUTES, totalMin)
const rangeMinutes = ranges => ranges.reduce((sum, range) => sum + range.end - range.start, 0)
const longestRange = ranges => ranges.length ? Math.max(...ranges.map(range => range.end - range.start)) : 0

/** Same effective-interval math the selection uses: adjacency buffers, rounding,
 * and the task deadline. Non-positive lengths are kept so the placement logic
 * makes exactly the same accept/reject calls it always did. */
function clampedRanges(state, date, ranges, deadline, bufferMin, notBefore = -Infinity) {
  const dayStart = dayStartOf(date)
  return ranges.map(range => ({
    start: Math.ceil(Math.max((notBefore - dayStart) / 60000, range.start + (state.blocks.some(block => block.date === date && minuteOf(block.end) === range.start) ? bufferMin : 0)) / 5) * 5,
    end: Math.min(Math.floor(range.end - (state.blocks.some(block => block.date === date && minuteOf(block.start) === range.end) ? bufferMin : 0)),
      Math.floor((deadline - dayStart) / 60000)),
  }))
}
const positiveRanges = ranges => ranges.filter(range => range.end > range.start)
/** Titles of the enabled available windows the saved block really occupies. */
function windowTitlesAt(state, date, start, end) {
  return [...new Set(routinesForDay(state, date)
    .filter(routine => routine.kind === 'available' && minuteOf(routine.start) < end && minuteOf(routine.end) > start)
    .map(routine => routine.title))]
}
function dayFacts(state, allTasks, date, effective, candidateCount) {
  return {
    date,
    classCount: routinesForDay(state, date).filter(routine => routine.kind === 'class').length,
    occupiedCount: blocksForDay(state, allTasks, date).length,
    maxFreeMin: longestRange(effective),
    totalFreeMin: rangeMinutes(effective),
    candidateCount,
  }
}

/** Occurrence instances are same-day, whole-slot placements. Everything here is
 * read-only observation of the same capacity the placement below uses. */
function occurrenceDay(task, state, allTasks, now, bufferMin) {
  const { date, preferredWindow, allowFallback } = task.occurrence
  const minutes = task.estimateMin
  if (date < localDay(now)) return null
  const capacity = dayCapacity(state, allTasks, date, now)
  const windows = routinesForDay(state, date).filter(routine => routine.kind === 'available' && routine.title === preferredWindow)
    .map(window => ({ start: minuteOf(window.start), end: minuteOf(window.end) }))
  const bounds = taskTimingBounds(task, state, allTasks)
  const clamped = bounds.unresolved.length ? [] : clampedRanges(state, date, capacity.remaining, Math.min(taskDeadline(task), bounds.notAfter), bufferMin, bounds.notBefore)
  const available = clamped.filter(range => range.end - range.start >= minutes)
  const intersect = ranges => mergeRanges(ranges.flatMap(range => windows.map(window => ({
    start: Math.max(range.start, window.start), end: Math.min(range.end, window.end),
  })).filter(range => range.start < range.end)))
  const mandatoryWindow = Boolean(preferredWindow) && !allowFallback
  const within = preferredWindow ? intersect(available).filter(range => range.end - range.start >= minutes) : available
  return {
    windows, available, within,
    // Explanation facts only: real positive effective intervals the placement could use.
    effective: positiveRanges(mandatoryWindow ? intersect(clamped) : clamped),
    candidates: mandatoryWindow ? within : available,
  }
}
function occurrencePlacement(task, day) {
  const { date, placement, preferredWindow, allowFallback } = task.occurrence
  const minutes = task.estimateMin
  const pickEdge = ranges => placement === 'end' ? ranges.at(-1) && { start: ranges.at(-1).end - minutes, end: ranges.at(-1).end }
    : ranges[0] && { start: ranges[0].start, end: ranges[0].start + minutes }
  const preferred = pickEdge(day.within)
  if (preferred) return { date, ...preferred, fallback: false }
  if (!allowFallback || !day.available.length) return null
  // A preferred window occupied by another event can fall back to the nearest
  // complete same-day slot, never to tomorrow or several fragments.
  const anchor = day.windows.length ? placement === 'end' ? Math.max(...day.windows.map(window => window.end)) - minutes
    : Math.min(...day.windows.map(window => window.start)) : null
  const alternative = anchor === null ? pickEdge(day.available) : day.available.map(range => {
    const start = Math.max(range.start, Math.min(anchor, range.end - minutes))
    return { start, end: start + minutes }
  }).sort((a, b) => Math.abs(a.start - anchor) - Math.abs(b.start - anchor) || a.start - b.start)[0]
  return alternative ? { date, ...alternative, fallback: Boolean(preferredWindow) } : null
}
const constraintsFor = (totalMin, date, preferredWindow, contiguous, bufferMin) => ({
  date, preferredWindow: preferredWindow ?? null, contiguous,
  minSegmentMin: segmentFloor(totalMin), bufferMin,
})

/** Pure placement against the same capacity calculation used by the calendar.
 * No existing block is moved; validation and commit still belong to the store.
 * The result also carries factual `evidence` (one item per processed task) that
 * explains the same decisions with real scanned days and real candidates; the
 * placement algorithm, plans, allocations and legacy unscheduled fields are
 * unchanged. Evidence never invents a day, a window, or a filler duration. */
export function initialTaskSchedule({ state, allTasks, tasks, now, idForBlock, bufferMin = 10, windowByTask = new Map(), dateByTask = new Map() }) {
  const plans = [], allocations = [], unscheduled = [], evidence = []
  const working = { ...state, blocks: [...state.blocks] }
  const today = localDay(now)
  const ordered = orderByTaskRelations([...tasks].filter(task => ['todo', 'doing'].includes(task.status) && task.kind !== 'reminder' && !task.freeTimeGoalId)
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || b.importance - a.importance))
  for (const task of ordered) {
    const estimated = !task.estimateMin
    const totalMin = task.estimateMin ?? DEFAULT_INITIAL_MINUTES
    const timing = taskTimingBounds(task, working, allTasks)
    if (timing.unresolved.length) {
      allocations.push({taskId:task.id,title:task.title,totalMin,scheduledMin:0,estimated})
      unscheduled.push({taskId:task.id,title:task.title,remainingMin:totalMin,cause:'unresolved_relationship',reason:'关联事项的时间未确定或先后关系冲突，未猜测安排',relations:timing.unresolved,maxFreeMin:0,availableMin:0,alternatives:[]})
      evidence.push({taskId:task.id,title:task.title,due:task.due??null,totalMin,scheduledMin:0,remainingMin:totalMin,relations:timing.facts,unresolvedRelations:timing.unresolved,chosen:[],evaluatedDays:[],truncated:false})
      continue
    }
    if (task.occurrence) {
      const day = occurrenceDay(task, working, allTasks, now, bufferMin)
      const slot = day && occurrencePlacement(task, day)
      const facts = day ? dayFacts(working, allTasks, task.occurrence.date, day.effective, day.candidates.length) : null
      if (slot && plans.length < 64) {
        const block = { id: idForBlock(task.id, plans.length), taskId: task.id, date: task.occurrence.date,
          start: timeOf(slot.start), end: timeOf(slot.end), locked: false }
        plans.push(block); working.blocks.push(block)
        allocations.push({ taskId: task.id, title: task.title, date: task.occurrence.date, totalMin, scheduledMin: totalMin, estimated,
          ...(task.occurrence.preferredWindow ? { preferredWindow: task.occurrence.preferredWindow, fallback: slot.fallback } : {}) })
        evidence.push({ taskId: task.id, title: task.title, due: task.due ?? null, relations: timing.facts, totalMin, scheduledMin: totalMin, remainingMin: 0,
          constraints: constraintsFor(totalMin, task.occurrence.date, task.occurrence.preferredWindow, true, bufferMin),
          selectionPolicy: 'same_day_contiguous',
          chosen: [{ date: block.date, start: block.start, end: block.end,
            windowTitles: windowTitlesAt(working, block.date, minuteOf(block.start), minuteOf(block.end)) }],
          evaluatedDays: facts ? [facts] : [], truncated: false })
      } else {
        allocations.push({ taskId: task.id, title: task.title, date: task.occurrence.date, totalMin, scheduledMin: 0, estimated })
        const maxFreeMin = day ? longestRange(day.effective) : 0
        const availableMin = day ? rangeMinutes(day.effective) : 0
        const cause = !day || taskDeadline(task) <= now.getTime() ? 'deadline_passed'
          : availableMin < totalMin ? 'insufficient_capacity' : 'no_contiguous_slot'
        unscheduled.push({ taskId: task.id, title: task.title, date: task.occurrence.date, remainingMin: totalMin,
          reason: `${task.occurrence.date} ${task.occurrence.preferredWindow && !task.occurrence.allowFallback ? `的「${task.occurrence.preferredWindow}」` : '当天'}没有可用的完整 ${totalMin} 分钟空档；保留当天实例，不拆段、不挪到其他日期`,
          cause, maxFreeMin, availableMin, alternatives: [] })
        evidence.push({ taskId: task.id, title: task.title, due: task.due ?? null, relations: timing.facts, totalMin, scheduledMin: 0, remainingMin: totalMin,
          constraints: constraintsFor(totalMin, task.occurrence.date, task.occurrence.preferredWindow, true, bufferMin),
          selectionPolicy: 'same_day_contiguous', chosen: [], evaluatedDays: facts ? [facts] : [], truncated: false })
      }
      continue
    }
    let remainingMin = totalMin
    const exactDate = dateByTask.get(task.id)
    const firstDate = exactDate ?? (task.startAt && task.startAt > today ? task.startAt : today)
    const deadline = Math.min(taskDeadline(task), timing.notAfter)
    const lastDate = exactDate ?? (Number.isFinite(deadline) ? localDay(new Date(deadline - 1)) : nextDay(firstDate, 6))
    // Prefer one continuous slot before splitting. Keep the earlier candidates
    // so a task with no complete slot can still use meaningful work sessions.
    const candidates = []
    let completeSlot
    const scan = { days: [], scannedCount: 0, maxFreeMin: 0, availableMin: 0, bounded: false }
    // One year is a bounded search horizon for a far-future explicitly dated task.
    let offset = 0
    for (; offset < 366 && !completeSlot && plans.length < 64; offset++) {
      const date = nextDay(firstDate, offset)
      if (date > lastDate) break
      if (exactDate && (date < today || (task.startAt && date < task.startAt))) continue
      const windowTitle = windowByTask.get(task.id)
      const windows = windowTitle ? routinesForDay(working, date).filter(routine => routine.kind === 'available' && routine.title === windowTitle) : []
      const capacity = dayCapacity(working, allTasks, date, now)
      const ranges = windowTitle ? mergeRanges(capacity.remaining.flatMap(range => windows.map(window => ({
        start: Math.max(range.start, minuteOf(window.start)), end: Math.min(range.end, minuteOf(window.end)),
      })).filter(range => range.start < range.end))) : capacity.remaining
      const clamped = clampedRanges(working, date, ranges, deadline, bufferMin, timing.notBefore)
      const effective = positiveRanges(clamped)
      scan.scannedCount++
      scan.maxFreeMin = Math.max(scan.maxFreeMin, longestRange(effective))
      scan.availableMin += rangeMinutes(effective)
      // Negated comparison kept verbatim from the previous algorithm so a
      // non-finite candidate length is accepted exactly as before; valid inputs
      // only ever produce finite lengths here.
      const legal = clamped.filter(range => !(range.end - range.start < segmentFloor(totalMin)))
      // A requested day must still hold the whole task; count only those complete
      // slots as its candidates, even though split candidates were also computed.
      const candidateCount = exactDate
        ? effective.filter(range => range.end - range.start >= totalMin).length
        : legal.length
      if (scan.days.length < MAX_EVIDENCE_DAYS) scan.days.push(dayFacts(working, allTasks, date, effective, candidateCount))
      for (const range of legal) {
        const slot = { date, start: range.start, end: range.end }
        candidates.push(slot)
        if (range.end - range.start >= totalMin) { completeSlot = slot; break }
      }
    }
    if (!completeSlot && (offset >= 366 || plans.length >= 64)) scan.bounded = true
    // A requested day still requires a complete slot. An explicit short task
    // is also kept whole; it is not permission to make a tiny tail on long work.
    const selected = completeSlot ? [completeSlot] : exactDate ? [] : candidates
    const planStart = plans.length
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
      slot.allocated = true
    }
    allocations.push({ taskId: task.id, title: task.title, ...(exactDate ? { date: exactDate } : {}), totalMin, scheduledMin: totalMin - remainingMin, estimated })
    const chosen = plans.slice(planStart).map(block => ({ date: block.date, start: block.start, end: block.end,
      windowTitles: windowTitlesAt(working, block.date, minuteOf(block.start), minuteOf(block.end)) }))
    if (remainingMin) {
      const requestedDatePassed = Boolean(exactDate && exactDate < today)
      const deadlinePassed = deadline <= now.getTime()
      const scheduledMin = totalMin - remainingMin
      const cause = deadlinePassed || requestedDatePassed ? 'deadline_passed'
        : exactDate ? (scan.availableMin < totalMin ? 'insufficient_capacity' : 'no_contiguous_slot')
          : (scan.availableMin - scheduledMin < remainingMin ? 'insufficient_capacity' : 'segment_limit')
      const alternatives = exactDate ? [] : candidates.filter(candidate => !candidate.allocated).slice(0, MAX_ALTERNATIVES)
        .map(candidate => ({ date: candidate.date, start: timeOf(candidate.start), end: timeOf(candidate.end), minutes: candidate.end - candidate.start }))
      unscheduled.push({ taskId: task.id, title: task.title, ...(exactDate ? { date: exactDate } : {}), remainingMin,
        reason: exactDate
          ? `${exactDate}${windowByTask.has(task.id) ? ` 的「${windowByTask.get(task.id)}」` : ' 当天'}没有可用的完整 ${totalMin} 分钟空档；未拆分或挪到其他日期，现有安排保持不变`
          : `${deadline <= now.getTime() ? '截止时间已过，未安排过去的时段' : `截止前${windowByTask.has(task.id) ? `的「${windowByTask.get(task.id)}」` : ''}没有足够的可用连续空档${totalMin > MIN_INITIAL_SEGMENT_MINUTES ? `（拆分时每段至少 ${MIN_INITIAL_SEGMENT_MINUTES} 分钟）` : ''}，现有安排保持不变`}；还剩 ${remainingMin} 分钟未安排`,
        cause, maxFreeMin: scan.maxFreeMin, availableMin: scan.availableMin, alternatives })
    }
    evidence.push({ taskId: task.id, title: task.title, due: task.due ?? null, relations: timing.facts, totalMin,
      scheduledMin: totalMin - remainingMin, remainingMin,
      constraints: constraintsFor(totalMin, exactDate ?? null, windowByTask.get(task.id), Boolean(exactDate), bufferMin),
      selectionPolicy: exactDate ? 'same_day_contiguous' : 'first_complete_then_split',
      chosen, evaluatedDays: scan.days, truncated: scan.bounded || scan.scannedCount > MAX_EVIDENCE_DAYS })
  }
  return { plans, allocations, unscheduled, evidence }
}
