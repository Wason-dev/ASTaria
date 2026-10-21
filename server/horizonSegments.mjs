import { sha256Hex } from './portable.mjs'
import { dayCapacity, minuteOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'
import { ValidationError, knownKeys, identifier, day, clockTime } from './validation.mjs'

const fail = (message, status = 409) => { throw new ValidationError(message, status) }
const MIN_PART = 15
const instant = (date, time) => new Date(`${date}T${time}:00`).getTime()
const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const duration = block => minuteOf(block.end) - minuteOf(block.start)
export const horizonSegmentId = (requestId, sourceId, part) => part === 0 ? sourceId
  : `horizon-part-${sha256Hex(JSON.stringify([requestId, sourceId, part])).slice(0, 32)}`
export const canSplitHorizonItem = (item, snap) => {
  const task = snap.taskMap.get(item.taskId)
  // Goal sessions carry a completion/frequency identity; recurring tasks are
  // explicitly one complete session. A generic split must not change either.
  return !task.occurrence && !task.freeTimeGoalId && !snap.goals.some(goal => goal.taskId === task.id)
}

export function horizonRemainingWindows(snap, date) {
  const earliest = date === localDay(snap.at) ? snap.at.getHours() * 60 + snap.at.getMinutes() + 1 : 0
  return dayCapacity(snap.working, snap.capacityTasks, date, snap.at).remaining
    .map(range => ({ start: Math.max(earliest, Math.ceil(range.start)), end: Math.min(1439, Math.floor(range.end)) }))
    .filter(range => range.start < range.end).sort((a, b) => a.start - b.start)
}

function endLimit(item, date, snap) {
  const due = snap.taskMap.get(item.taskId).due
  if (!due) return 1439
  const end = due.length === 10 ? new Date(`${due}T23:59:59.999`) : new Date(due)
  return Math.min(1439, Math.floor((end.getTime() - new Date(`${date}T00:00:00`).getTime()) / 60000))
}

/** Only invoked after a user has explicitly allowed fragments for this draft. */
export function splitHorizonPlan(input, snap) {
  const byId = new Map(snap.movable.map(item => [item.id, item]))
  const plans = []
  for (const date of snap.dates) {
    const items = input.orderedIds.filter(id => input.assignedDates[id] === date).map(id => byId.get(id))
    const windows = horizonRemainingWindows(snap, date)
    let after = 0
    for (const item of items) {
      if (input.reflowDates instanceof Set && !input.reflowDates.has(date)) {
        plans.push({ id: item.id, sourceId: item.id, date: item.date, start: item.start, end: item.end })
        continue
      }
      let remaining = item.durationMin, part = 0
      for (const window of windows) {
        const start = Math.max(after, window.start), end = Math.min(window.end, endLimit(item, date, snap))
        const room = end - start
        if (room <= 0) continue
        let minutes = Math.min(remaining, room)
        if (minutes < remaining) {
          if (!canSplitHorizonItem(item, snap)) continue
          if (remaining - minutes < MIN_PART) minutes = remaining - MIN_PART
          if (minutes < MIN_PART) continue
        }
        if (minutes <= 0) continue
        plans.push({ id: horizonSegmentId(input.requestId, item.id, part++), sourceId: item.id, date,
          start: clock(start), end: clock(start + minutes) })
        after = start + minutes
        remaining -= minutes
        if (remaining === 0) break
      }
      if (remaining) fail(`${date} 的「${item.title}」仍缺少 ${remaining} 分钟可用时间，原日程保持不变`)
      if (plans.length > 128) fail('分段后超过 128 段，原日程保持不变，请减少本次调整范围')
    }
  }
  return plans
}

/** A question is not a receipt or a journal entry: no planner is changed. */
export function horizonSchedulingQuestion(input, snap, wholePlan) {
  if (input.fragmentPolicy) return null
  const today = localDay(snap.at)
  if (!input.reflowDates.has(today)) return null
  const windows = horizonRemainingWindows(snap, today)
  const nowMinute = snap.at.getHours() * 60 + snap.at.getMinutes()
  const current = windows[0]
  if (!current || current.start > nowMinute + 1) return null
  // Establish that the offered split is actually feasible before offering it.
  let fragments, whole
  try { fragments = splitHorizonPlan(input, snap) } catch { return null }
  try { whole = wholePlan(input, snap) } catch { whole = null }
  const first = fragments.find(plan => plan.date === today && minuteOf(plan.start) < current.end
    && fragments.filter(part => part.sourceId === plan.sourceId).length > 1)
  if (!first) return null
  const item = snap.movable.find(item => item.id === first.sourceId)
  const parts = fragments.filter(plan => plan.sourceId === item.id)
  if (parts.length < 2 || !canSplitHorizonItem(item, snap)) return null
  if (whole?.some(plan => plan.id === item.id && minuteOf(plan.start) < current.end)) return null
  const otherSplits = snap.movable.filter(other => other.id !== item.id && fragments.filter(plan => plan.sourceId === other.id).length > 1)
  const extra = otherSplits.length ? `\n选择分段时，本次还有 ${otherSplits.length} 项也会按空档分段：${otherSplits.slice(0, 3).map(other => `「${other.title.slice(0, 80)}」`).join('、')}${otherSplits.length > 3 ? '等' : ''}；每项总时长保持不变。` : ''
  return { prompt: `今天（${today}）「${item.title}」需要 ${item.durationMin} 分钟，当前 ${clock(current.start)}–${clock(current.end)} 空档只能先做 ${duration(first)} 分钟。要先利用这段时间，还是保留完整一段？${extra}`,
    options: [
      { value: 'split', label: `先做 ${duration(first)} 分钟，其余接到后续空档` },
      ...(whole ? [{ value: 'whole', label: '保留完整一段，放到后续空档' }] : []),
      { value: 'cancel', label: '先不改，返回调整' },
    ], sourceId: item.id, snapshotKey: snap.view.snapshotKey }
}

export function validateHorizonSegments(raw, input, snap) {
  if (!Array.isArray(raw) || raw.length < snap.movable.length || raw.length > 128) fail('分段安排没有完整保留原事项，原日程保持不变')
  const original = new Map(snap.state.blocks.map(block => [block.id, block]))
  const movable = new Map(snap.movable.map(item => [item.id, item]))
  const positions = new Map(input.orderedIds.map((id, i) => [id, i]))
  const used = new Set(), totals = new Map(), count = new Map(), plans = []
  const working = { ...snap.working, blocks: [...snap.working.blocks] }
  let previousPosition = -1, previousEnd = -Infinity
  for (const value of raw) {
    knownKeys(value, ['id', 'sourceId', 'date', 'start', 'end'], '弦轨分段安排')
    const id = identifier(value.id), sourceId = identifier(value.sourceId), date = day(value.date)
    const start = clockTime(value.start), end = clockTime(value.end), item = movable.get(sourceId)
    if (!item || used.has(id)) fail('分段安排包含无关或重复事项，原日程保持不变')
    const part = count.get(sourceId) ?? 0
    if (id !== horizonSegmentId(input.requestId, sourceId, part)) fail('分段标识不属于当前请求，原日程保持不变')
    if (part > 0 && !canSplitHorizonItem(item, snap)) fail('重复事项与余时目标的单次安排不能拆段')
    if (id !== sourceId && original.has(id)) fail('分段标识与已有安排冲突')
    const before = original.get(sourceId), task = snap.taskMap.get(item.taskId)
    if (!snap.dates.includes(date) || date !== input.assignedDates[sourceId]) fail('分段安排没有保留所选日期')
    if (start >= end) fail('分段安排的结束时间必须晚于开始时间')
    if (task.occurrence && date !== task.occurrence.date) fail('重复事项只能保留在实例日期')
    const goal = snap.goals.find(goal => goal.id === task.freeTimeGoalId || goal.taskId === task.id)
    if (goal?.targetDate && date > goal.targetDate) fail('分段安排超过余时目标日期')
    if (minuteOf(end) > endLimit(item, date, snap)) fail(`「${task.title}」的分段安排超过截止时间`)
    const untouched = input.reflowDates instanceof Set && !input.reflowDates.has(date)
    const preserved = id === sourceId && before.date === date && before.start === start && before.end === end
    const preservedElapsed = untouched && preserved && instant(date, start) <= snap.at.getTime()
    if (untouched && !preserved) fail('分段不能更改本次未调整的日期')
    if (!preservedElapsed && instant(date, start) <= snap.at.getTime()) fail('分段开始时间已经过去，请重新读取')
    const position = positions.get(sourceId)
    if (position < previousPosition || (!untouched && instant(date, start) < previousEnd)) fail('分段安排没有保留所选顺序')
    if (!preservedElapsed && !dayCapacity(working, snap.capacityTasks, date, snap.at).remaining.some(
      range => minuteOf(start) >= range.start && minuteOf(end) <= range.end)) fail('分段安排与课程、固定活动或其他事项重叠')
    const minutes = minuteOf(end) - minuteOf(start)
    used.add(id); count.set(sourceId, part + 1); totals.set(sourceId, (totals.get(sourceId) ?? 0) + minutes)
    const block = { ...before, id, date, start, end, sourceId }
    plans.push(block); working.blocks.push(block)
    previousPosition = position; previousEnd = instant(date, end)
  }
  for (const item of snap.movable) {
    if (totals.get(item.id) !== item.durationMin) fail(`「${item.title}」的完整时长未保留`)
    if ((count.get(item.id) ?? 0) > 1 && plans.some(plan => plan.sourceId === item.id && duration(plan) < MIN_PART)) fail('拆分后的每段至少保留 15 分钟')
  }
  return plans
}

export function decorateHorizonSegments(plans, input, snap) {
  const groups = new Map(input.groups.flatMap(group => group.itemIds.map(id => [id, group])))
  return plans.map(({ sourceId, ...plan }) => {
    const group = groups.get(sourceId), previous = snap.view.groups.find(g => g.id === group.id)
    return { ...plan, horizonGroupId: group.id, horizonGroupTitle: group.title ?? previous.title }
  })
}
