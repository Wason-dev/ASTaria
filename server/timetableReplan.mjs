import { blocksForDay, dayCapacity, minuteOf, routinesForDay, timeOf } from '../src/planner/model.ts'
import { agendaDate, localDay } from '../src/home/agenda.ts'
import { day } from './validation.mjs'

const MINUTE = 60_000
const minuteAt = at => at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60 + at.getMilliseconds() / MINUTE
const nextMidnight = at => new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)
const localInstant = (date, minutes) => {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 1440) return NaN
  const at = agendaDate(`${date}T${timeOf(minutes)}:00`)
  return at && localDay(at) === date && minuteAt(at) === minutes ? at.getTime() : NaN
}
const deadlineFor = task => {
  if (!task.due) return Infinity
  const due = agendaDate(task.due)
  return due ? (task.due.length === 10 ? nextMidnight(due) : due).getTime() : NaN
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

function occupiedRanges(state, tasks, date) {
  const explicit = new Set(state.blocks.map(block => block.id)), byId = new Map(tasks.map(task => [task.id, task]))
  const start = agendaDate(date), end = nextMidnight(start)
  return blocksForDay(state, tasks, date).map(block => {
    if (explicit.has(block.id)) return { start: minuteOf(block.start), end: minuteOf(block.end) }
    // Display blocks round implicit times to a minute. Rest must still start at
    // the actual second-level end of an existing startAt task.
    const task = byId.get(block.taskId), from = agendaDate(task.startAt)
    const to = new Date(from.getTime() + task.estimateMin * MINUTE)
    return { start: from <= start ? 0 : minuteAt(from), end: to >= end ? 1440 : minuteAt(to) }
  })
}

function nearestSlot({ before, task, working, tasks, date, now, bufferMin }) {
  const duration = minuteOf(before.end) - minuteOf(before.start), originalStart = minuteOf(before.start)
  const capacity = dayCapacity(working, tasks, date, now), occupied = occupiedRanges(working, tasks, date)
  // remaining is already inside known availability, minus fixed and task time,
  // and clipped to the real current instant on today.
  const available = capacity.remaining.map(range => {
    let start = range.start, end = Math.min(range.end, 1439)
    for (const block of occupied) {
      if (block.end <= range.start) start = Math.max(start, block.end + bufferMin)
      if (block.start >= range.end) end = Math.min(end, block.start - bufferMin)
    }
    return { start, end }
  }).filter(range => range.end - range.start >= duration)
  const deadline = deadlineFor(task), todayBoundary = date === localDay(now) ? Math.ceil(minuteAt(now)) : null
  const pick = ranges => {
    const candidates = []
    for (const range of ranges) {
      const latest = range.end - duration, starts = new Set()
      for (let start = Math.ceil(range.start / 5) * 5; start <= latest; start += 5) starts.add(start)
      // A real minute boundary today can fit when rounding it up to the next
      // five-minute tick would discard the only complete slot. Never round now down.
      if (todayBoundary !== null && todayBoundary >= range.start && todayBoundary <= latest) starts.add(todayBoundary)
      for (const start of starts) {
        const end = start + duration, from = localInstant(date, start), to = localInstant(date, end)
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < now.getTime() || to > deadline || to - from !== duration * MINUTE) continue
        candidates.push({ start, end })
      }
    }
    return candidates.sort((a, b) => Math.abs(a.start - originalStart) - Math.abs(b.start - originalStart) || a.start - b.start)[0]
  }
  const preferredWindow = task.occurrence?.preferredWindow
  if (preferredWindow) {
    const windows = mergeRanges(routinesForDay(working, date)
      .filter(row => row.kind === 'available' && row.title === preferredWindow)
      .map(row => ({ start: minuteOf(row.start), end: minuteOf(row.end) })))
    const within = available.flatMap(range => windows.map(window => ({
      start: Math.max(range.start, window.start), end: Math.min(range.end, window.end),
    }))).filter(range => range.end - range.start >= duration)
    const preferred = pick(within)
    if (preferred) return preferred
    if (!task.occurrence.allowFallback) return null
  }
  return pick(available)
}

/** Pure projection of an already changed timetable; callers own permission,
 * batch application and receipts. No task, fixed event or original block is deleted. */
export function replanTimetableConflicts({ state, allTasks, date, now, maxMoves = 7, bufferMin = 10 }) {
  day(date)
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('重排需要有效的当前时刻')
  if (!Number.isSafeInteger(maxMoves) || maxMoves < 0) throw new RangeError('移动上限需要非负整数')
  if (!Number.isFinite(bufferMin) || bufferMin < 0) throw new RangeError('休息间隔需要非负分钟数')
  if (!Array.isArray(state?.blocks) || !Array.isArray(allTasks)) throw new TypeError('重排需要日程和事项快照')
  // One timetable action plus at most seven moves fits the normal eight-action store limit.
  const limit = Math.min(7, maxMoves), capacity = dayCapacity(state, allTasks, date, now)
  const original = new Map(state.blocks.map(block => [block.id, block])), tasks = new Map(allTasks.map(task => [task.id, task]))
  const projected = new Map(blocksForDay(state, allTasks, date).map(block => [block.id, block]))
  const unresolved = new Map(), eligible = []
  const defer = (id, taskId, reason) => unresolved.set(id, { id, taskId, reason })
  for (const id of capacity.conflicts) {
    const before = original.get(id)
    if (!before) {
      const implicit = projected.get(id)
      defer(id, implicit?.taskId ?? null, implicit ? '这是 startAt 形成的隐式时段，需明确修改事项开始时间，未自动移动'
        : '固定课程或活动之间的冲突需手动核对，未自动移动')
      continue
    }
    const task = tasks.get(before.taskId), duration = minuteOf(before.end) - minuteOf(before.start)
    let reason
    if (before.date !== date) reason = '安排不属于目标日，未跨日移动'
    else if (before.locked !== false) reason = '安排已锁定，需先由你解锁，未自动移动'
    else if (!task || task.deletedAt) reason = '关联事项不存在或已删除，未自动移动'
    else if (task.status !== 'todo') reason = task.status === 'doing' ? '事项正在进行，未自动移动'
      : task.status === 'done' ? '事项已完成，保留原时间记录' : '事项不是待办状态，未自动移动'
    else if (state.completedFreeTimeSessions?.[id]) reason = '本次余时已完成，保留原时间记录'
    else if (date < localDay(now) || localInstant(date, minuteOf(before.start)) < now.getTime()) reason = '安排已开始或属于过去，未自动移动'
    else if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(localInstant(date, minuteOf(before.start)))
      || !Number.isFinite(localInstant(date, minuteOf(before.end)))) reason = '原安排没有有效的完整正时长，需手动核对'
    else if (task.occurrence && (task.occurrence.date !== date || state.blocks.filter(block => block.taskId === task.id).length !== 1)) reason = '重复实例的日期或单日唯一时段不一致，需手动核对'
    else if (Number.isNaN(deadlineFor(task))) reason = '事项截止时间无效，需手动核对'
    if (reason) defer(id, before.taskId, reason)
    else eligible.push(before)
  }
  eligible.sort((a, b) => minuteOf(a.start) - minuteOf(b.start) || minuteOf(a.end) - minuteOf(b.end) || a.id.localeCompare(b.id))
  // Temporarily removing a real plan must not resurrect that task's superseded
  // startAt interval. Actual implicit tasks keep their original occupancy.
  const explicitTasks = new Set(state.blocks.map(block => block.taskId))
  const capacityTasks = allTasks.map(task => explicitTasks.has(task.id) && task.startAt ? { ...task, startAt: undefined } : task)
  const waiting = [...eligible], active = waiting.splice(0, limit)
  let moves = []
  while (active.length) {
    const removed = new Set(active.map(block => block.id)), working = structuredClone(state)
    working.blocks = working.blocks.filter(block => !removed.has(block.id))
    const trial = [], failed = new Set()
    for (const before of active) {
      const task = tasks.get(before.taskId), slot = nearestSlot({ before, task, working, tasks: capacityTasks, date, now, bufferMin })
      if (slot) {
        const after = { ...structuredClone(before), start: timeOf(slot.start), end: timeOf(slot.end) }
        working.blocks.push(after)
        trial.push({ before: structuredClone(before), after })
      } else {
        working.blocks.push(structuredClone(before))
        failed.add(before.id)
        const preferred = task.occurrence?.preferredWindow && !task.occurrence.allowFallback ? `的「${task.occurrence.preferredWindow}」窗口内` : ''
        defer(before.id, before.taskId, `调课后当天${preferred}没有截止前完整 ${minuteOf(before.end) - minuteOf(before.start)} 分钟的已知可用空档（保留 ${bufferMin} 分钟任务间休息）；原安排保留，不拆段、不缩短、不越日`)
      }
    }
    if (!failed.size) { moves = trial.filter(({ before, after }) => before.start !== after.start || before.end !== after.end); break }
    // A failed original can overlap an earlier tentative destination. Retry the
    // survivors with every failed original present, rather than returning a new conflict.
    for (let index = active.length - 1; index >= 0; index--) if (failed.has(active[index].id)) active.splice(index, 1)
    active.push(...waiting.splice(0, limit - active.length))
  }
  for (const before of waiting) defer(before.id, before.taskId, `本次最多移动 ${limit} 段，余下安排未处理，原时段保留`)
  const replacements = new Map(moves.map(move => [move.after.id, move.after]))
  const finalConflicts = new Set(dayCapacity({ ...state, blocks: state.blocks.map(block => replacements.get(block.id) ?? block) }, allTasks, date, now).conflicts)
  return { moves, unresolved: capacity.conflicts.flatMap(id => unresolved.has(id) && finalConflicts.has(id) ? [unresolved.get(id)] : []) }
}
