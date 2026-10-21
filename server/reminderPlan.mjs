import { blocksForDay, routinesForDay } from '../src/planner/model.ts'
import { agendaDate, localDay, shiftDay } from '../src/home/agenda.ts'
import { sha256Hex as hash } from './portable.mjs'

export { hash }

function allowed(at, quiet) {
  const minute = at.getHours() * 60 + at.getMinutes()
  const parse = x => Number(x.slice(0, 2)) * 60 + Number(x.slice(3))
  const start = parse(quiet.quietStart), end = parse(quiet.quietEnd)
  return start === end || (start < end ? minute < start || minute >= end : minute < start && minute >= end)
}

/** Pure projection: only persisted, open work; no model, no invented deadlines. */
export function buildReminderPlan({ tasks, planner, preferences }, now = new Date()) {
  const entries = new Map(), end = shiftDay(now, 30).getTime()
  const add = (id, title, body, at) => {
    if (!Number.isFinite(at.getTime()) || at <= now || at.getTime() > end || !allowed(at, preferences.notifications)) return
    entries.set(id, { id: `astaria.${hash(id).slice(0, 40)}`, title: title.slice(0, 200), body: body.slice(0, 1000), at: Math.floor(at.getTime() / 1000) })
  }
  const persisted = new Map(planner.blocks.map(block => [block.id, block]))
  const open = tasks.filter(t => !t.deletedAt && ['todo', 'doing'].includes(t.status)), byId = new Map(open.map(t => [t.id, t]))
  for (let offset = 0; offset <= 30; offset++) {
    const date = localDay(shiftDay(now, offset))
    for (const block of blocksForDay(planner, open, date)) {
      const task = byId.get(block.taskId)
      const original = persisted.get(block.id)
      const implicitStart = !original && task?.startAt ? agendaDate(task.startAt) : null
      if ((original && original.date !== date) || (implicitStart && localDay(implicitStart) !== date)) continue
      if (!task || (task.freeTimeGoalId && (!original || (Object.hasOwn(planner.completedFreeTimeSessions ?? {}, block.id) && planner.completedFreeTimeSessions[block.id])))) continue
      const start = new Date(`${date}T${block.start}:00`), early = new Date(start.getTime() - 5 * 60_000)
      add(`session:${block.id}:${date}`, `即将开始：${task.title}`, `${block.start}–${block.end}${task.freeTimeGoalId ? ' · 本次余时' : ''}`, early)
    }
    for (const routine of routinesForDay(planner, date).filter(r => r.kind === 'class')) {
      const start = new Date(`${date}T${routine.start}:00`), early = new Date(start.getTime() - 5 * 60_000)
      add(`routine:${routine.id}:${date}`, `即将开始：${routine.title}`, `${routine.start}–${routine.end}${routine.location ? ` · ${routine.location}` : ''}`, early)
    }
  }
  for (const task of open.filter(t => t.due)) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(task.due)
    const due = agendaDate(task.due)
    if (!due) continue
    const at = dateOnly ? new Date(`${task.due}T20:00:00`) : new Date(due.getTime() - 30 * 60_000)
    add(`deadline:${task.id}`, dateOnly ? `今天截止：${task.title}` : `即将截止：${task.title}`, dateOnly ? '今天还有这项事项待完成' : `截止 ${due.toLocaleString('zh-CN', { hour12: false })}`, at)
  }
  const all = [...entries.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  return { entries: all.slice(0, 64), omitted: Math.max(0, all.length - 64) }
}
