import { randomUUID } from 'node:crypto'
import { ValidationError, knownKeys, day, identifier, text, choice } from './validation.mjs'
import { dayCapacity, blocksForDay, minuteOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'

const fail = (message, status = 400) => { throw new ValidationError(message, status) }
const timeOf = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const minutes = block => minuteOf(block.end) - minuteOf(block.start)
const atTime = (date, time) => new Date(`${date}T${time}:00`).getTime()
const datesFrom = (date, count = 7) => Array.from({ length: count }, (_, index) => {
  const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() + index); return localDay(value)
})
const goalValid = (db, goal) => {
  if (goal.status === 'deleted') return false
  if (goal.source?.kind !== 'conversation') return true
  const source = db.getMessage(goal.source.messageId)
  return source && !source.retractedAt && !source.excludeFromContext
}
const stateOf = db => {
  const value = db.getCompanionState()
  return { ...value, freeTimeGoals: value.freeTimeGoals ?? [], freeTimeHistory: value.freeTimeHistory ?? [] }
}
const requiredCount = (goal, date) => goal.minPerWeek || (goal.targetDate && goal.targetDate >= date && goal.targetDate <= datesFrom(date, 14).at(-1)
  ? 4 : goal.priority === 'high' ? 3 : goal.priority === 'low' ? 1 : 2)
const taskAvailable = task => task && !task.deletedAt && ['todo', 'doing'].includes(task.status)
// A goal is ongoing; completing or dropping one backing task does not pause it.
const schedulingStatus = goal => goal.status === 'paused' ? 'paused' : 'active'
const DAILY_POLICY_VERSION = 2

/** Read actual blocks and explicit check-ins. A past planned slot is never
 * counted as completed merely because its clock time has passed. */
export function freeTimeState(db, { date = localDay(new Date()), days = 7, now = new Date() } = {}) {
  const value = stateOf(db), dates = datesFrom(date, days), planner = db.getPlanner()
  const goals = value.freeTimeGoals.filter(goal => goalValid(db, goal))
  const byTask = new Map(goals.filter(goal => goal.taskId && taskAvailable(db.getTask(goal.taskId))).map(goal => [goal.taskId, goal]))
  const history = new Map(value.freeTimeHistory.map(item => [item.sessionId, item]))
  const freeTimeSessions = planner.blocks.filter(block => byTask.has(block.taskId) && dates.includes(block.date) && !db.getTask(block.taskId)?.deletedAt)
    .map(block => ({ ...block, goalId: byTask.get(block.taskId).id, title: byTask.get(block.taskId).title, completed: history.has(block.id) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start))
  const freeTimeProgress = goals.map(goal => {
    const scheduled = freeTimeSessions.filter(item => item.goalId === goal.id)
    const completed = value.freeTimeHistory.filter(item => item.goalId === goal.id && dates.includes(item.date))
    const completedIds = new Set(completed.map(item => item.sessionId))
    const fulfilled = completed.filter(item => item.minutes >= goal.sessionMin).length + scheduled.filter(item => !completedIds.has(item.id) && minutes(item) >= goal.sessionMin && atTime(item.date, item.end) > now.getTime()).length
    const required = requiredCount(goal, date)
    return { goalId: goal.id, schedulingStatus: schedulingStatus(goal), taskUpdatedAt: goal.taskId ? db.getTask(goal.taskId)?.updatedAt ?? null : null,
      scheduledCount: scheduled.length, completedCount: completed.length,
      scheduledMin: scheduled.reduce((sum, item) => sum + minutes(item), 0), completedMin: completed.reduce((sum, item) => sum + item.minutes, 0),
      required, remainingCount: goal.status === 'paused' ? 0 : Math.max(0, required - fulfilled), shortSessionCount: scheduled.filter(item => minutes(item) < goal.sessionMin).length }
  })
  const freeTimeBreaks = freeTimeSessions.flatMap(session => {
    const end = minuteOf(session.end), free = dayCapacity(planner, db.listTasks(), session.date, now).free
    const range = free.find(item => item.start <= end && item.end >= end + 10)
    return range ? [{ date: session.date, start: session.end, end: timeOf(end + 10) }] : []
  })
  const freeTimeFeedback = value.freeTimeHistory.filter(item => goals.some(goal => goal.id === item.goalId)).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 40)
  return { freeTimeSessions, freeTimeProgress, freeTimeBreaks, freeTimeFeedback }
}

export function createFreeTime({ db, now = () => new Date() }) {
  function schedule(input = {}, source) {
    knownKeys(input, ['date'], '余时安排')
    const at = new Date(now()), date = day(input.date ?? localDay(at)), dates = datesFrom(date)
    if (date < localDay(at)) fail('余时安排从今天或未来开始')
    return db.transaction(() => {
      const operationId = source?.actionId ? `free-time:${identifier(source.actionId)}` : `free-time:${randomUUID()}`
      const replay = source?.actionId && db.listOperations().find(item => item.id === operationId)
      if (replay) {
        if (replay.undoneAt) fail('这次余时安排已经撤销，请重新发起安排', 409)
        const state = freeTimeState(db, { date, now: at })
        return { operation: replay, sessions: state.freeTimeSessions, addedSessions: [], progress: state.freeTimeProgress, goals: stateOf(db).freeTimeGoals.filter(goal => goalValid(db, goal)), shortfalls: [] }
      }
      const value = stateOf(db), planner = db.getPlanner(), tasks = db.listTasks(), working = structuredClone(planner)
      const goals = value.freeTimeGoals.filter(goal => goal.status === 'active' && goalValid(db, goal))
      const priority = { high: 0, normal: 1, low: 2 }
      goals.sort((a, b) => (a.targetDate ?? '9999').localeCompare(b.targetDate ?? '9999') || priority[a.priority] - priority[b.priority] || a.createdAt.localeCompare(b.createdAt))
      const actions = [], shortfalls = [], bufferMin = Math.max(10, Math.min(60, db.getPreference('app')?.scheduling?.bufferMin ?? 10))
      for (const goal of goals) {
        const required = requiredCount(goal, date)
        let task = goal.taskId ? db.getTask(goal.taskId) : null
        // Renew only when a real slot is found. Keep the old task and its blocks
        // inactive: their time may already have been taken by other work.
        if (!taskAvailable(task)) task = null
        const completed = value.freeTimeHistory.filter(item => item.goalId === goal.id && dates.includes(item.date))
        const completedIds = new Set(completed.map(item => item.sessionId))
        const existing = task ? working.blocks.filter(block => block.taskId === task.id && dates.includes(block.date)) : []
        const shortSessions = existing.filter(block => minutes(block) < goal.sessionMin).length
        let fulfilled = completed.filter(item => item.minutes >= goal.sessionMin).length + existing.filter(block => !completedIds.has(block.id) && minutes(block) >= goal.sessionMin && atTime(block.date, block.end) > at.getTime()).length
        const counts = new Map(dates.map(currentDate => [currentDate, existing.filter(block => block.date === currentDate).length]))
        // One pass places at most one session on a date. A second pass is only
        // used for explicit frequencies over seven sessions per week.
        while (fulfilled < required && actions.length < 100) {
          let candidate
          const intended = Math.min(dates.length - 1, Math.floor(fulfilled * dates.length / required))
          const ordered = dates.map((currentDate, index) => ({ date: currentDate, index }))
            .sort((a, b) => (counts.get(a.date) ?? 0) - (counts.get(b.date) ?? 0) || Math.abs(a.index - intended) - Math.abs(b.index - intended) || a.index - b.index)
          for (const current of ordered) {
            if ((counts.get(current.date) ?? 0) >= Math.max(1, Math.ceil(required / 7)) || (goal.targetDate && current.date > goal.targetDate)) continue
            const capacity = dayCapacity(working, tasks, current.date, at), occupied = blocksForDay(working, tasks, current.date)
            for (const range of capacity.remaining) {
              let start = Math.ceil(range.start / 5) * 5, end = Math.floor(range.end)
              // Rest is reserved as unoccupied time, not another checkbox task.
              for (const block of occupied) {
                if (minuteOf(block.end) <= start) start = Math.max(start, minuteOf(block.end) + bufferMin)
                if (minuteOf(block.start) >= end) end = Math.min(end, minuteOf(block.start) - bufferMin)
              }
              const urgent = goal.targetDate && goal.targetDate <= datesFrom(date, 14).at(-1)
              const preferred = urgent || goal.priority === 'high' ? goal.sessionMax : Math.round((goal.sessionMin + goal.sessionMax) / 2 / 5) * 5
              const duration = Math.min(goal.sessionMax, Math.max(goal.sessionMin, preferred), end - start)
              if (duration >= goal.sessionMin) { candidate = { date: current.date, start: timeOf(start), end: timeOf(start + duration) }; break }
            }
            if (candidate) break
          }
          if (!candidate) break
          if (!task) {
            task = db.createTask({ title: goal.title, source: 'recurring', freeTimeGoalId: goal.id, inbox: false, estimateMin: goal.sessionMin, importance: goal.priority === 'high' ? 3 : goal.priority === 'low' ? 1 : 2,
              notes: `余时长期目标：${goal.title}${goal.targetNote ? `\n${goal.targetNote}` : ''}`, status: 'todo' })
            tasks.push(task); goal.taskId = task.id; goal.version += 1; goal.updatedAt = at.toISOString()
          }
          const block = { id: `free-time:${randomUUID()}`, taskId: task.id, ...candidate, locked: false }
          working.blocks.push(block); actions.push({ type: 'save-block', block })
          counts.set(candidate.date, (counts.get(candidate.date) ?? 0) + 1); fulfilled += 1
        }
        if (fulfilled < required) shortfalls.push({ goalId: goal.id, title: goal.title, required, scheduled: fulfilled,
          reason: `${shortSessions ? `${shortSessions} 段已有安排短于单次最低时长，未计入频率；` : ''}保留已有安排与至少 ${bufferMin} 分钟休息后，未来七天还缺 ${required - fulfilled} 次完整学习空档` })
      }
      let operation = null
      if (actions.length) {
        operation = db.applyPlannerOperation({ id: operationId, requestId: source?.requestId ?? operationId, summary: `余时已安排 ${actions.length} 段学习，保留学习间的休息`, actions, expectedRevision: planner.revision }, { scenario: true })
        db.saveCompanionState(value)
      }
      // An explicit schedule is also today's scheduling pass. Reopening the
      // app after undoing it must not silently recreate its time blocks.
      if (date === localDay(at)) db.setPreference('free-time-daily', { date, completedAt: at.toISOString(), policyVersion: DAILY_POLICY_VERSION })
      const state = freeTimeState(db, { date, now: at })
      return { sessions: state.freeTimeSessions, addedSessions: actions.map(action => action.block), progress: state.freeTimeProgress, goals: stateOf(db).freeTimeGoals.filter(goal => goalValid(db, goal)), shortfalls, operation }
    })
  }

  // An explicit goal restart permits new sessions. Never revive the old task:
  // its dropped slots may now overlap work scheduled while it was inactive.
  function resume(input) {
    knownKeys(input, ['id', 'expectedVersion', 'expectedTaskUpdatedAt', 'date'], '恢复余时目标')
    return db.transaction(() => {
      const value = stateOf(db), goal = value.freeTimeGoals.find(item => item.id === identifier(input.id))
      if (!goal || !goalValid(db, goal)) fail('这个余时目标已不存在，请重新读取', 409)
      if (!Number.isSafeInteger(input.expectedVersion) || goal.version !== input.expectedVersion) fail('目标已在其他窗口修改，请重新读取后再恢复', 409)
      const task = goal.taskId ? db.getTask(goal.taskId) : null
      if ((task?.updatedAt ?? null) !== input.expectedTaskUpdatedAt) fail('关联事项已在其他窗口修改，请重新读取后再恢复', 409)
      if (goal.taskId && !taskAvailable(task)) delete goal.taskId
      goal.status = 'active'; goal.version += 1; goal.updatedAt = new Date(now()).toISOString()
      db.saveCompanionState(value)
      return schedule({ date: input.date })
    })
  }

  function completeSession(input) {
    knownKeys(input, ['sessionId', 'feedback', 'nextStep'], '余时学习反馈')
    return db.transaction(() => {
      const sessionId = identifier(input.sessionId), value = stateOf(db), previous = value.freeTimeHistory.find(item => item.sessionId === sessionId)
      if (previous) {
        const updated = { ...previous,
          ...(input.feedback === undefined ? {} : { feedback: choice(input.feedback, ['smooth', 'stuck', 'continue'], '学习反馈') }),
          ...(input.nextStep === undefined ? {} : { nextStep: text(input.nextStep, '下次接着做', 1500, { empty: true }) }) }
        value.freeTimeHistory = value.freeTimeHistory.map(item => item.sessionId === sessionId ? updated : item)
        db.saveCompanionState(value)
        return updated
      }
      const block = db.getPlanner().blocks.find(item => item.id === sessionId), goal = value.freeTimeGoals.find(item => item.taskId === block?.taskId)
      if (!block || !goal || !goalValid(db, goal)) fail('找不到这段余时安排', 404)
      const record = { sessionId, goalId: goal.id, date: block.date, minutes: minutes(block),
        feedback: choice(input.feedback, ['smooth', 'stuck', 'continue'], '学习反馈', 'smooth'), nextStep: text(input.nextStep ?? '', '下次接着做', 1500, { empty: true }), completedAt: new Date(now()).toISOString() }
      if (value.freeTimeHistory.length >= 5000) fail('余时学习记录较多，请先整理历史记录', 409)
      value.freeTimeHistory.push(record); db.saveCompanionState(value)
      return record
    })
  }
  function ensureDaily() {
    const date = localDay(new Date(now())), previous = db.getPreference('free-time-daily')
    if (previous?.date === date) {
      // Repair the old scheduler's blocked goals once on upgrade. Otherwise
      // respect today's pass, including a user's subsequent schedule undo.
      const needsRepair = previous.policyVersion !== DAILY_POLICY_VERSION && stateOf(db).freeTimeGoals
        .some(goal => goal.status === 'active' && goalValid(db, goal) && goal.taskId && !taskAvailable(db.getTask(goal.taskId)))
      if (!needsRepair) return { ensured: false, date }
    }
    return db.transaction(() => {
      const result = schedule({ date })
      return { ...result, ensured: true, date }
    })
  }
  return { schedule, resume, ensureDaily, completeSession, state: (input = {}) => {
    knownKeys(input, ['date', 'days'], '读取余时')
    const date = day(input.date ?? localDay(new Date(now()))), days = input.days ?? 7
    if (!Number.isInteger(days) || days < 1 || days > 31) fail('余时查看天数应在1–31之间')
    return { goals: stateOf(db).freeTimeGoals.filter(goal => goalValid(db, goal)), ...freeTimeState(db, { date, days, now: new Date(now()) }) }
  } }
}
