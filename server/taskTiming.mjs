import { routinesForDay } from '../src/planner/model.ts'

const active = task => task && !task.deletedAt && task.status !== 'dropped'
const instant = (date, time) => new Date(`${date}T${time}:00`).getTime()

/** Resolve model-selected relationships using real identities and current
 * calendar times. An unknown predecessor is not permission to guess a slot. */
export function taskTimingBounds(task, state, tasks) {
  if (!task.relations?.length) return { notBefore: -Infinity, notAfter: Infinity, facts: [], unresolved: [] }
  const byId = new Map(tasks.filter(active).map(item => [item.id, item]))
  const edges = new Map()
  for (const item of tasks.filter(active)) for (const relation of item.relations ?? []) {
    if (relation.kind !== 'task') continue
    const from = relation.relation === 'before' ? item.id : relation.id
    const to = relation.relation === 'before' ? relation.id : item.id
    edges.set(from, [...(edges.get(from) ?? []), to])
  }
  const visited = new Set()
  const visit = (id, path = new Set()) => {
    if (path.has(id)) return true
    if (visited.has(id)) return false
    const next = new Set(path).add(id)
    const cycle = (edges.get(id) ?? []).some(other => visit(other, next))
    visited.add(id)
    return cycle
  }
  const facts = [], unresolved = []
  let notBefore = -Infinity, notAfter = Infinity
  if (visit(task.id)) unresolved.push({ cause: 'relationship_cycle', taskId: task.id })
  for (const relation of task.relations ?? []) {
    let target, start, end
    if (relation.kind === 'event') {
      target = state.dayEvents?.find(item => item.id === relation.id) ?? routinesForDay(state, relation.date).find(item => item.id === relation.id && item.kind !== 'available')
      if (target) { const date = target.date ?? relation.date; start = instant(date, target.start); end = instant(date, target.end) }
    } else {
      target = byId.get(relation.id)
      const blocks = state.blocks.filter(block => block.taskId === relation.id && (!relation.date || block.date === relation.date))
      if (blocks.length) {
        start = Math.min(...blocks.map(block => instant(block.date, block.start)))
        end = Math.max(...blocks.map(block => instant(block.date, block.end)))
      } else if (target?.status === 'done' && target.doneAt) end = Date.parse(target.doneAt)
    }
    const boundary = relation.relation === 'before' ? start : end
    if (!target || !Number.isFinite(boundary)) { unresolved.push({ ...relation, cause: target ? 'target_time_unknown' : 'target_missing' }); continue }
    if (relation.relation === 'before') notAfter = Math.min(notAfter, boundary)
    else notBefore = Math.max(notBefore, boundary)
    facts.push({ ...relation, title: target.title, boundary: new Date(boundary).toISOString() })
  }
  if (notBefore >= notAfter) unresolved.push({ cause: 'incompatible_time_bounds' })
  return { notBefore, notAfter, facts, unresolved }
}

export function timingViolation(task, block, state, tasks) {
  const bounds = taskTimingBounds(task, state, tasks)
  if (bounds.unresolved.length) return { cause: 'unresolved_relationship', facts: bounds.unresolved }
  if (instant(block.date, block.start) < bounds.notBefore || instant(block.date, block.end) > bounds.notAfter) return { cause: 'relationship_time_conflict', facts: bounds.facts }
  return null
}

/** Stable temporal order for known task relationships. Cycles are left for the
 * resolver to report; no sorting by a model's prose or guessed subject. */
export function orderByTaskRelations(tasks) {
  const pending = new Map(tasks.map(task => [task.id, task])), result = []
  while (pending.size) {
    const next = [...pending.values()].find(task => !(task.relations ?? []).some(relation => relation.kind === 'task' && pending.has(relation.id)))
    if (!next) return [...result, ...pending.values()]
    pending.delete(next.id); result.push(next)
  }
  return result
}
