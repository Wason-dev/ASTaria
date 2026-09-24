import { randomUUID } from 'node:crypto'
import { ValidationError, knownKeys, text, identifier, choice, day, dateTime, number } from './validation.mjs'
import { dayCapacity, carryItems, blocksForDay, routinesForDay, minuteOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'
import { freeTimeState } from './freeTime.mjs'

const fail = (message, status = 400) => { throw new ValidationError(message, status) }
const active = task => task && !task.deletedAt && ['todo', 'doing'].includes(task.status)
const timeOf = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
const duration = block => minuteOf(block.end) - minuteOf(block.start)
const instant = (date, time) => new Date(`${date}T${time}:00`).getTime()
const deadline = task => !task.due ? Infinity : task.due.length === 10
  ? new Date(`${task.due}T23:59:59.999`).getTime() : Date.parse(task.due)
const datesFrom = (date, count) => Array.from({ length: count }, (_, index) => {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + index)
  return localDay(value)
})
const strings = (value, label, count = 20) => {
  if (!Array.isArray(value) || value.length > count) fail(`${label}最多 ${count} 项`)
  return [...new Set(value.map(item => text(item, label, 300))) ]
}
const version = (current, expected) => {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected !== (current?.version ?? 0)) fail('内容已在其他窗口修改，请刷新后重试', 409)
}

/** All mutations run against SQLite snapshots. A preview never changes tasks or
 * the planner; applying it rechecks every constraint inside one transaction. */
export function createCompanion({ db, now = () => new Date() }) {
  const clock = () => new Date(now())
  const timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone
  const state = () => {
    const value = db.getCompanionState()
    return { handoffs: [], wishes: [], scenarios: [], ...value, freeTimeGoals: value.freeTimeGoals ?? [], freeTimeHistory: value.freeTimeHistory ?? [] }
  }
  const save = value => {
    if (value.wishes.length > 500 || value.freeTimeGoals.length > 500 || value.handoffs.length > 2000 || value.scenarios.length > 100) fail('本地记录较多，请先清理旧记录', 409)
    return db.saveCompanionState(value)
  }
  const validSource = source => source?.kind !== 'conversation' || (() => {
    const message = db.getMessage(source.messageId)
    return message && !message.excludeFromContext && !message.retractedAt
  })()
  const sourceValue = (source, evidence) => {
    if (!source || source.kind === 'user') return { kind: 'user', ...(evidence ? { evidence } : {}), ...(source?.actionId ? { actionId: identifier(source.actionId) } : {}) }
    const messageId = identifier(source.messageId, '原话来源'), message = db.getMessage(messageId)
    if (source.kind !== 'conversation' || !message || message.role !== 'user' || message.excludeFromContext || message.retractedAt) fail('原话来源已失效', 409)
    const quote = text(evidence ?? source.evidence, '原话', 2000)
    if (!message.content.includes(quote)) fail('需要引用用户消息中的连续原话')
    return { kind: 'conversation', messageId, evidence: quote,
      ...(source.actionId ? { actionId: identifier(source.actionId) } : {}) }
  }
  const requireTask = id => {
    const task = db.getTask(identifier(id, '任务标识'))
    if (!task || task.deletedAt) fail('任务已不存在', 404)
    return task
  }

  function saveHandoff(input, source) {
    knownKeys(input, ['taskId', 'progress', 'obstacle', 'nextStep', 'materials', 'expectedVersion'], '接力记录')
    return db.transaction(() => {
      const task = requireTask(input.taskId), value = state(), previous = value.handoffs.find(item => item.taskId === task.id)
      if (source?.actionId && previous?.source.actionId === source.actionId) return previous
      version(previous, input.expectedVersion ?? (previous ? undefined : 0))
      const stamp = clock().toISOString()
      const record = { taskId: task.id, progress: text(input.progress, '已完成的部分', 1500, { empty: true }),
        obstacle: text(input.obstacle, '卡点', 1500, { empty: true }), nextStep: text(input.nextStep, '下一步', 1500, { empty: true }),
        materials: strings(input.materials, '相关材料'), version: (previous?.version ?? 0) + 1,
        source: sourceValue(source), createdAt: previous?.createdAt ?? stamp, updatedAt: stamp }
      value.handoffs = [...value.handoffs.filter(item => item.taskId !== task.id), record]
      save(value)
      return record
    })
  }
  function clearHandoff(taskId, expectedVersion) {
    return db.transaction(() => {
      const value = state(), current = value.handoffs.find(item => item.taskId === identifier(taskId))
      version(current, expectedVersion)
      value.handoffs = value.handoffs.filter(item => item.taskId !== taskId)
      save(value)
      return { cleared: true, taskId }
    })
  }
  function saveWish(input, source) {
    knownKeys(input, ['id', 'content', 'evidence', 'minutes', 'items', 'expiresAt', 'expectedVersion'], '牵挂')
    return db.transaction(() => {
      const value = state(), previous = input.id ? value.wishes.find(item => item.id === identifier(input.id)) : undefined
      const replay = source?.actionId && value.wishes.find(item => item.source.actionId === source.actionId)
      if (replay) return replay
      if (input.id && !previous) fail('找不到这条牵挂', 404)
      if (previous?.status === 'deleted') fail('这条牵挂已删除', 410)
      version(previous, input.expectedVersion ?? (previous ? undefined : 0))
      const evidence = text(input.evidence, '牵挂原话', 2000)
      const expiresAt = input.expiresAt == null ? null : dateTime(input.expiresAt, '有效期')
      if (expiresAt && (!expiresAt.includes('T') || Date.parse(expiresAt) <= clock().getTime())) fail('有效期需要在将来并包含时区')
      const minutes = number(input.minutes, '希望留出的分钟数', 5, 720, previous?.minutes ?? 30)
      if (!Number.isInteger(minutes)) fail('分钟数需要为整数')
      const stamp = clock().toISOString()
      const record = { id: previous?.id ?? randomUUID(), content: text(input.content, '牵挂内容', 600), evidence,
        minutes, minutesEstimated: input.minutes === undefined ? (previous?.minutesEstimated ?? true) : false,
        items: strings(input.items ?? [], '所需条件'), expiresAt,
        status: previous?.status ?? 'active', version: (previous?.version ?? 0) + 1,
        source: sourceValue(source, evidence), createdAt: previous?.createdAt ?? stamp, updatedAt: stamp }
      value.wishes = [...value.wishes.filter(item => item.id !== record.id), record]
      save(value)
      return record
    })
  }
  function updateWish(id, input) {
    knownKeys(input, ['status', 'expectedVersion'], '牵挂状态')
    return db.transaction(() => {
      const value = state(), current = value.wishes.find(item => item.id === identifier(id))
      if (!current || current.status === 'deleted') fail('找不到这条牵挂', 404)
      version(current, input.expectedVersion)
      const status = choice(input.status, ['active', 'paused', 'deleted'], '牵挂状态')
      const record = { ...current, status, version: current.version + 1, updatedAt: clock().toISOString() }
      // Delete removes the content rather than leaving a hidden copy in state.
      value.wishes = status === 'deleted' ? value.wishes.filter(item => item.id !== id) : value.wishes.map(item => item.id === id ? record : item)
      save(value)
      return record
    })
  }

  /**
   * A free-time goal is a durable learning/interest target. It is deliberately
   * separate from a task: saving one does not create a task or occupy the
   * planner. The future scheduler can use its preference range and weekly
   * minimum when it chooses otherwise-empty time.
   */
  function saveFreeTimeGoal(input, source) {
    knownKeys(input, ['id', 'title', 'evidence', 'priority', 'minPerWeek', 'sessionMin', 'sessionMax', 'targetDate', 'targetNote', 'status', 'expectedVersion', 'fromWishId', 'expectedWishVersion'], '余时目标')
    return db.transaction(() => {
      const value = state(), previous = input.id ? value.freeTimeGoals.find(item => item.id === identifier(input.id)) : undefined
      const wish = input.fromWishId ? value.wishes.find(item => item.id === identifier(input.fromWishId)) : null
      if (input.fromWishId) {
        const migrated = value.freeTimeGoals.find(item => item.fromWishId === input.fromWishId)
        if (migrated) return migrated
        if (!wish || !validSource(wish.source)) fail('这条牵挂已不存在', 404)
        version(wish, input.expectedWishVersion)
      }
      const replay = source?.actionId && value.freeTimeGoals.find(item => item.source?.actionId === source.actionId)
      if (replay) return replay
      if (input.id && !previous) fail('找不到这个余时目标', 404)
      if (previous?.status === 'deleted') fail('这个余时目标已移除', 410)
      version(previous, input.expectedVersion ?? (previous ? undefined : 0))
      const title = text(input.title ?? previous?.title ?? wish?.content, '余时目标名称', 160)
      const evidence = text(input.evidence ?? previous?.evidence ?? wish?.evidence ?? title, '原话', 2000)
      const priority = choice(input.priority, ['high', 'normal', 'low'], '余时目标优先级', previous?.priority ?? 'normal')
      const minPerWeek = number(input.minPerWeek, '每周最低次数', 0, 14, previous?.minPerWeek ?? 0)
      const sessionMin = number(input.sessionMin, '单次最短分钟数', 5, 720, previous?.sessionMin ?? 20)
      const sessionMax = number(input.sessionMax, '单次最长分钟数', 5, 720, previous?.sessionMax ?? 40)
      if (![minPerWeek, sessionMin, sessionMax].every(Number.isInteger)) fail('余时目标的次数与分钟数需要为整数')
      if (sessionMax < sessionMin) fail('单次最长分钟数不能小于最短分钟数')
      const status = choice(input.status, ['active', 'paused', 'deleted'], '余时目标状态', previous?.status ?? 'active')
      const targetDate = input.targetDate === undefined ? previous?.targetDate ?? null : input.targetDate == null ? null : day(input.targetDate, '阶段目标日期')
      const targetNote = text(input.targetNote ?? previous?.targetNote ?? '', '阶段目标', 1500, { empty: true })
      const stamp = clock().toISOString()
      const record = { id: previous?.id ?? randomUUID(), title, evidence, priority, minPerWeek, sessionMin, sessionMax,
        targetDate, targetNote, ...(previous?.taskId ? { taskId: previous.taskId } : {}),
        ...(previous?.fromWishId || wish ? { fromWishId: previous?.fromWishId ?? wish.id } : {}),
        status, version: (previous?.version ?? 0) + 1, source: sourceValue(source, evidence),
        createdAt: previous?.createdAt ?? stamp, updatedAt: stamp }
      value.freeTimeGoals = status === 'deleted'
        ? value.freeTimeGoals.filter(item => item.id !== record.id)
        : [...value.freeTimeGoals.filter(item => item.id !== record.id), record]
      if (status === 'deleted' && record.taskId) db.retireFreeTimeTask(record.taskId, clock())
      if (status === 'deleted') value.freeTimeHistory = value.freeTimeHistory.filter(item => item.goalId !== record.id)
      else if (record.taskId) {
        const task = db.getTask(record.taskId)
        if (task && !task.deletedAt) db.updateTask(task.id, { title, importance: priority === 'high' ? 3 : priority === 'low' ? 1 : 2, estimateMin: sessionMin })
      }
      if (wish) value.wishes = value.wishes.map(item => item.id === wish.id ? { ...item, status: 'paused', version: item.version + 1, updatedAt: stamp } : item)
      save(value)
      return record
    })
  }

  function updateFreeTimeGoal(id, input) {
    return saveFreeTimeGoal({ ...input, id: identifier(id, '余时目标标识') }, undefined)
  }

  // Internal persistence boundary: routeAnalysis validates the complete model
  // proposal and current snapshot inside the caller's database transaction.
  function saveRouteScenario(record) {
    return db.transaction(() => {
      const value = state()
      if (value.scenarios.some(item => item.id === record.id)) fail('推演标识已经存在', 409)
      value.scenarios.push(record)
      if (value.scenarios.length > 100) value.scenarios = value.scenarios.filter(item => item.status === 'preview').concat(value.scenarios.filter(item => item.status !== 'preview').slice(-30))
      save(value)
      return record
    })
  }

  function previewScenario(input, source) {
    knownKeys(input, ['date', 'days', 'mode', 'taskIds', 'budgetMin'], '推演')
    const date = day(input.date), days = number(input.days, '推演天数', 1, 7, 3)
    if (!Number.isInteger(days)) fail('天数需要为整数')
    const mode = choice(input.mode, ['rebalance', 'rest', 'light'], '推演方式')
    const budgetMin = number(input.budgetMin, '每日目标负荷', 15, 720, mode === 'light' ? 90 : 240)
    if (!Number.isInteger(budgetMin)) fail('目标分钟数需要为整数')
    if (input.taskIds !== undefined && (!Array.isArray(input.taskIds) || input.taskIds.length > 64 || new Set(input.taskIds).size !== input.taskIds.length)) fail('推演任务最多64项，且不可重复')
    return db.transaction(() => {
      const value = state(), replay = source?.actionId && value.scenarios.find(item => item.source?.actionId === source.actionId)
      if (replay) return replay
      const at = clock(), planner = db.getPlanner(), allTasks = db.listTasks(), dates = datesFrom(date, days)
      if (date < localDay(at)) fail('请选择今天或未来的日期')
      const ids = input.taskIds ? new Set(input.taskIds.map(id => requireTask(id).id)) : null
      const selected = allTasks.filter(task => active(task) && (!ids || ids.has(task.id)))
      if (selected.length > 64) fail('请先选择最多64项任务进行推演')
      const selectedIds = new Set(selected.map(task => task.id))
      const occurrenceIds = new Set(selected.filter(task => task.occurrence || task.freeTimeGoalId).map(task => task.id))
      const movable = planner.blocks.filter(block => selectedIds.has(block.taskId) && !occurrenceIds.has(block.taskId) && dates.includes(block.date) &&
        !block.locked && instant(block.date, block.start) >= at.getTime())
      if (movable.length > 64) fail('这一范围包含较多安排，请缩短推演天数')
      const removedBlockIds = movable.map(block => block.id)
      const working = { ...planner, blocks: planner.blocks.filter(block => !removedBlockIds.includes(block.id)) }
      const bufferMin = Math.round(Math.min(60, Math.max(0, db.getPreference('app')?.scheduling?.bufferMin ?? 10)))
      const slots = dates.flatMap(currentDate => dayCapacity(working, allTasks, currentDate, at).remaining.map(range => ({
        date: currentDate, start: Math.ceil(range.start / 5) * 5 + bufferMin, end: Math.floor(range.end) - bufferMin,
      })).filter(range => range.end > range.start))
      const id = randomUUID(), plans = [], unscheduled = [], warnings = [], used = new Map(dates.map(currentDate => [currentDate,
        working.blocks.filter(block => block.date === currentDate && instant(block.date, block.end) > at.getTime() && active(allTasks.find(task => task.id === block.taskId)))
          .reduce((sum, block) => sum + duration(block), 0)]))
      const maxEnd = instant(dates.at(-1), '23:59') + 59_999
      const sorted = [...selected].sort((a, b) => deadline(a) - deadline(b) || b.importance - a.importance || a.createdAt.localeCompare(b.createdAt))
      for (const task of sorted) {
        if (task.freeTimeGoalId) {
          warnings.push(`${task.title}：保留余时目标的各次学习安排；频率与学习节奏请在余时页调整`)
          continue
        }
        // Daily instances are date-bound, indivisible sessions. A general
        // load-balancing preview must not turn them back into fungible effort.
        if (task.occurrence) {
          if (dates.includes(task.occurrence.date)) {
            const blocks = working.blocks.filter(block => block.taskId === task.id)
            const valid = blocks.length === 1 && blocks[0].date === task.occurrence.date
            if (!valid) unscheduled.push({ taskId: task.id, title: task.title, remainingMin: task.estimateMin,
              reason: `${task.occurrence.date} 的重复实例尚需当天完整${task.estimateMin}分钟，保持日期不变` })
            else warnings.push(`${task.title}：保留${task.occurrence.date}的每日安排`)
          }
          continue
        }
        // Keep exact legacy startAt placements stable; changing only one side
        // of that representation would make preview and real occupancy differ.
        if (task.startAt?.includes('T') && !planner.blocks.some(block => block.taskId === task.id)) {
          warnings.push(`${task.title} 已有精确开始时间，保持原安排`)
          continue
        }
        // A past plan is not evidence of completed work. Only still-future
        // placements reserve this task's estimated effort in other slots.
        const held = working.blocks.filter(block => block.taskId === task.id && instant(block.date, block.end) > at.getTime())
          .reduce((sum, block) => sum + Math.min(duration(block), Math.max(0, Math.ceil((instant(block.date, block.end) - at.getTime()) / 60_000))), 0)
        if (working.blocks.some(block => block.taskId === task.id && instant(block.date, block.end) <= at.getTime())) {
          warnings.push(`${task.title} 的过去计划不代表已完成，按当前预计用时继续考虑；实际进度可在任务中调整`)
        }
        const removedMin = movable.filter(block => block.taskId === task.id).reduce((sum, block) => sum + duration(block), 0)
        let remaining = Math.max(0, task.estimateMin === undefined ? removedMin : Math.ceil(task.estimateMin) - held)
        if (!task.estimateMin && !removedMin) {
          unscheduled.push({ taskId: task.id, title: task.title, remainingMin: null, reason: '还需要确认预计用时' })
          continue
        }
        const limit = deadline(task), hardWithinWindow = Number.isFinite(limit) && limit <= maxEnd
        for (const slot of slots) {
          if (!remaining || plans.length >= 64 || (mode === 'rest' && slot.date === date)) continue
          const dueMinute = Math.floor((limit - instant(slot.date, '00:00')) / 60_000)
          const end = Math.min(slot.end, Number.isFinite(limit) ? dueMinute : 1439)
          while (remaining > 0 && end - slot.start >= Math.min(5, remaining) && plans.length < 64) {
            const already = used.get(slot.date) ?? 0
            const budget = hardWithinWindow ? Infinity : Math.max(0, budgetMin - already)
            const chunk = Math.floor(Math.min(remaining, end - slot.start, budget, mode === 'light' ? 35 : 60))
            if (chunk < Math.min(5, remaining)) break
            plans.push({ id: randomUUID(), taskId: task.id, title: task.title, date: slot.date,
              start: timeOf(slot.start), end: timeOf(slot.start + chunk) })
            used.set(slot.date, already + chunk)
            remaining -= chunk
            slot.start += chunk + bufferMin
          }
        }
        if (remaining > 0) unscheduled.push({ taskId: task.id, title: task.title, remainingMin: remaining,
          reason: limit < at.getTime() ? '截止时间已过，需要你决定后续' : hardWithinWindow ? '截止前的明确空闲不足，保持原DDL并等待你决定' : '目标负荷或明确空闲不足，继续保留待安排' })
      }
      if (mode === 'rest') warnings.push(`${date} 不增加任务安排，已锁定或开始的时段保持原样`)
      if (mode === 'light' && [...used.values()].some(minutes => minutes > budgetMin)) warnings.push('临近的明确DDL需要超过轻量目标，已标出实际负荷；你可以继续调整')
      if (unscheduled.some(item => item.reason.includes('截止'))) warnings.push('仍有截止风险，应用方案不会修改任何DDL')
      if (!slots.length) warnings.push('这些日期还没有可用的明确空闲，请先补充时间表')
      const record = { id, version: 1, status: 'preview', baseRevision: planner.revision, date, days, mode, budgetMin, bufferMin,
        timezone: timezone(), plans, removedBlockIds, unscheduled, warnings,
        taskVersions: Object.fromEntries(allTasks.map(task => [task.id, task.updatedAt])),
        source: source ? sourceValue(source) : { kind: 'user' }, createdAt: at.toISOString(),
        metrics: { scheduledMin: plans.reduce((sum, plan) => sum + duration(plan), 0),
          unscheduledMin: unscheduled.reduce((sum, item) => sum + (item.remainingMin ?? 0), 0), bufferMin },
      }
      value.scenarios.push(record)
      // Keep a bounded audit trail; active previews are kept until explicitly
      // replaced/discarded, with an explicit limit rather than silent loss.
      if (value.scenarios.length > 100) value.scenarios = value.scenarios.filter(item => item.status === 'preview').concat(value.scenarios.filter(item => item.status !== 'preview').slice(-30))
      save(value)
      return record
    })
  }

  /** A decision is deliberately local to one task. Weekly repetition is a
   * projection assumption, never permission to manufacture recurring work. */
  function previewDecision(input) {
    knownKeys(input, ['date', 'taskId', 'strategy', 'recurrence', 'todayMin'], '决策推演')
    const date = day(input.date), taskId = identifier(input.taskId, '任务标识')
    const strategy = choice(input.strategy, ['today', 'split', 'defer'], '决策路径')
    const recurrence = choice(input.recurrence, ['once', 'weekly'], '持续条件')
    const todayMin = number(input.todayMin, '今天先做的分钟数', 5, 720, 30)
    if (!Number.isInteger(todayMin)) fail('分钟数需要为整数')
    return db.transaction(() => {
      const at = clock(), task = requireTask(taskId)
      if (!active(task)) fail('已完成或已放下的任务不能推演', 409)
      if (task.occurrence) fail(`这项任务是${task.occurrence.date}的每日实例，保留当天的一个时段；改期请编辑该实例，调整实际时长请编辑原日程块`, 409)
      if (task.freeTimeGoalId) fail('这是一项余时长期目标，请在余时页调整频率与学习节奏，不按一次性任务重排', 409)
      if (date < localDay(at)) fail('请选择今天或未来的日期')
      const planner = db.getPlanner(), tasks = db.listTasks(), dates = datesFrom(date, 7), value = state()
      const original = planner.blocks.filter(block => block.taskId === taskId)
      const baseline = dates.flatMap(currentDate => blocksForDay(planner, tasks, currentDate)
        .filter(block => block.taskId === taskId).map(({ id, taskId, date, start, end }) => ({ id, taskId, title: task.title, date, start, end })))
      const movable = original.filter(block => dates.includes(block.date) && !block.locked && instant(block.date, block.start) >= at.getTime())
      if (movable.length > 64) fail('这一范围包含较多安排，请先缩小任务安排范围')
      const removedBlockIds = movable.map(block => block.id), removed = new Set(removedBlockIds)
      const working = { ...planner, blocks: planner.blocks.filter(block => !removed.has(block.id)) }
      const remainingDuration = block => Math.min(duration(block), Math.max(0, Math.ceil((instant(block.date, block.end) - at.getTime()) / 60_000)))
      const held = original.filter(block => !removed.has(block.id)).reduce((sum, block) => sum + remainingDuration(block), 0)
      const heldToday = original.filter(block => !removed.has(block.id) && block.date === date).reduce((sum, block) => sum + remainingDuration(block), 0)
      const movableMin = movable.reduce((sum, block) => sum + duration(block), 0)
      const estimated = Number.isFinite(task.estimateMin) && task.estimateMin > 0 ? Math.ceil(task.estimateMin) : null
      // Capture effort before removing blocks. Preserve already committed work
      // when its duration exceeds an older estimate, without counting it twice.
      const effortMin = estimated === null ? (movableMin || null) : Math.max(estimated, held + movableMin)
      let remaining = estimated === null ? movableMin : Math.max(0, effortMin - held)
      const bufferMin = Math.round(Math.min(60, Math.max(0, db.getPreference('app')?.scheduling?.bufferMin ?? 10)))
      const plans = [], unscheduled = [], warnings = []
      const exactLegacy = task.startAt?.includes('T') && original.length === 0
      if (exactLegacy) {
        remaining = 0
        warnings.push('这项任务已有精确开始时间，保持原安排；请先在任务详情调整开始时间再比较')
      }
      if (original.some(block => instant(block.date, block.end) <= at.getTime())) warnings.push('过去的计划不代表已完成；推演依据当前预计用时，实际进度可在任务中调整')
      if (original.some(block => !removed.has(block.id) && dates.includes(block.date) && instant(block.date, block.end) > at.getTime())) warnings.push('已锁定或已开始的时段保持原样')
      if (estimated !== null && held + movableMin > estimated) warnings.push(`已有未来安排合计 ${held + movableMin} 分钟，长于任务估时 ${estimated} 分钟；本次按已有工作量推演，不因换位置缩短任务`)
      if (recurrence === 'weekly') warnings.push('每周持续只是远期投影条件；应用仅调整本次 7 天内的安排')
      if (effortMin === null) unscheduled.push({ taskId, title: task.title, remainingMin: null, reason: '还需要确认预计用时；没有为未知工作量虚构时长' })
      // Removing the last explicit block must not temporarily resurrect a stale
      // legacy startAt while finding replacement slots. The persisted task is
      // untouched, and a removal-only result below keeps this fallback stable.
      const capacityTasks = original.length ? tasks.map(item => item.id === taskId ? { ...item, startAt: undefined } : item) : tasks
      const slots = dates.flatMap(currentDate => dayCapacity(working, capacityTasks, currentDate, at).remaining.map(range => ({
        date: currentDate, start: Math.ceil(range.start / 5) * 5 + bufferMin, end: Math.floor(range.end) - bufferMin,
      })).filter(range => range.end > range.start))
      const limit = deadline(task)
      let usedToday = heldToday
      for (const slot of slots) {
        if (remaining <= 0 || plans.length >= 64 || (strategy === 'defer' && slot.date === date)) continue
        const dueMinute = Math.floor((limit - instant(slot.date, '00:00')) / 60_000)
        const end = Math.min(slot.end, Number.isFinite(limit) ? dueMinute : 1440)
        while (remaining > 0 && plans.length < 64) {
          const budget = strategy === 'split' && slot.date === date ? Math.max(0, todayMin - usedToday) : Infinity
          const chunk = Math.floor(Math.min(remaining, end - slot.start, budget, 60))
          if (chunk < Math.min(5, remaining)) break
          plans.push({ id: randomUUID(), taskId, title: task.title, date: slot.date, start: timeOf(slot.start), end: timeOf(slot.start + chunk) })
          if (slot.date === date) usedToday += chunk
          remaining -= chunk
          slot.start += chunk + bufferMin
        }
      }
      if (remaining > 0) unscheduled.push({ taskId, title: task.title, remainingMin: remaining,
        reason: limit < at.getTime() ? '截止时间已过，需要重新决定完成时间' : limit <= instant(dates.at(-1), '24:00')
          ? '这条路径在截止前的明确空闲不足，保留原 DDL，剩余部分待安排' : '未来 7 天的明确空闲不足，剩余部分待安排' })
      const spillMin = plans.filter(plan => plan.date > date).reduce((sum, plan) => sum + duration(plan), 0)
      if (strategy === 'today' && spillMin > 0) warnings.push(`${date} 的明确空闲不足以全部完成；${spillMin} 分钟需在随后几天补完，具体时段见对比`)
      if (strategy === 'defer') warnings.push(`${date} 不新增这项任务；已锁定或已开始的原安排保留`)
      if (strategy === 'split') warnings.push(`${date} 新旧安排合计最多按 ${todayMin} 分钟试排；已锁定或已开始的安排不强行缩短`)
      if (!slots.length) warnings.push('未来 7 天没有明确可用空闲，请先补充时间表')
      if (unscheduled.some(item => item.reason.includes('截止'))) warnings.push('这条路径存在截止风险，应用不会修改 DDL')
      if (!plans.length && task.startAt?.includes('T') && original.length && !working.blocks.some(block => block.taskId === taskId)) {
        removedBlockIds.length = 0
        warnings.push('原精确开始时间仍有效，暂保留原时段，避免移除后旧时间重新出现')
      }
      const record = { id: randomUUID(), version: 1, status: 'preview', baseRevision: planner.revision, date, days: 7,
        mode: strategy === 'defer' ? 'rest' : strategy === 'split' ? 'light' : 'rebalance', budgetMin: todayMin, bufferMin,
        timezone: timezone(), decision: { taskId, title: task.title, strategy, recurrence, todayMin, effortMin, baseline },
        plans, removedBlockIds, unscheduled, warnings, taskVersions: Object.fromEntries(tasks.map(item => [item.id, item.updatedAt])),
        source: { kind: 'user' }, createdAt: at.toISOString(),
        metrics: { scheduledMin: plans.reduce((sum, plan) => sum + duration(plan), 0),
          unscheduledMin: unscheduled.reduce((sum, item) => sum + (item.remainingMin ?? 0), 0), bufferMin } }
      value.scenarios.push(record)
      if (value.scenarios.length > 100) value.scenarios = value.scenarios.filter(item => item.status === 'preview').concat(value.scenarios.filter(item => item.status !== 'preview').slice(-30))
      save(value)
      return record
    })
  }

  function applyScenario(id, input) {
    knownKeys(input, ['expectedVersion'], '应用方案')
    return db.transaction(() => {
      const value = state(), record = value.scenarios.find(item => item.id === identifier(id))
      if (!record) fail('找不到这份方案', 404)
      if (record.status === 'applied') {
        const operation = db.listOperations().find(item => item.id === record.operationId)
        if (!operation?.undoneAt) return { scenario: record, operation }
        fail('这份方案已经撤销，请重新推演', 409)
      }
      version(record, input.expectedVersion)
      if (record.status !== 'preview') fail('这份方案已经关闭，请重新推演', 409)
      if (!validSource(record.source)) fail('方案的来源消息已撤回或删除，请重新推演', 409)
      const planner = db.getPlanner(), tasks = db.listTasks(), at = clock()
      if (planner.revision !== record.baseRevision) fail('时间表已有变化，请重新推演', 409)
      if (timezone() !== record.timezone) fail('本机时区已变化，请重新推演', 409)
      const versions = Object.fromEntries(tasks.map(task => [task.id, task.updatedAt]))
      if (Object.keys(versions).length !== Object.keys(record.taskVersions).length || Object.entries(record.taskVersions).some(([key, stamp]) => versions[key] !== stamp)) fail('任务已有变化，请重新推演', 409)
      if (record.decision) {
        const currentBuffer = Math.round(Math.min(60, Math.max(0, db.getPreference('app')?.scheduling?.bufferMin ?? 10)))
        if (record.bufferMin !== currentBuffer) fail('安排缓冲设置已有变化，请重新推演', 409)
        if (record.plans.some(plan => plan.taskId !== record.decision.taskId || !datesFrom(record.date, 7).includes(plan.date))) fail('决策方案超出本次任务或日期范围，请重新推演', 409)
      }
      for (const blockId of record.removedBlockIds) {
        const block = planner.blocks.find(item => item.id === blockId)
        if (!block || block.locked || instant(block.date, block.start) < at.getTime()) fail('原安排已经锁定、开始或变化，请重新推演', 409)
        if (record.decision && (block.taskId !== record.decision.taskId || !datesFrom(record.date, 7).includes(block.date))) fail('决策方案超出本次任务或日期范围，请重新推演', 409)
      }
      const working = { ...planner, blocks: planner.blocks.filter(block => !record.removedBlockIds.includes(block.id)) }
      const capacityTasks = record.decision && planner.blocks.some(block => block.taskId === record.decision.taskId) && record.plans.length
        ? tasks.map(task => task.id === record.decision.taskId ? { ...task, startAt: undefined } : task) : tasks
      for (const plan of record.plans) {
        const task = requireTask(plan.taskId), start = minuteOf(plan.start), end = minuteOf(plan.end)
        if (!active(task) || instant(plan.date, plan.start) < at.getTime()) fail('任务状态或时间已有变化，请重新推演', 409)
        if (instant(plan.date, plan.end) > deadline(task)) fail('方案超过了任务DDL，请重新推演', 409)
        const capacity = dayCapacity(working, capacityTasks, plan.date, at)
        const margin = record.decision ? record.bufferMin : 0
        if (!capacity.remaining.some(range => range.start + margin <= start && range.end - margin >= end)) fail('方案已不在明确的可用空闲与缓冲中，请重新推演', 409)
        working.blocks.push({ id: plan.id, taskId: plan.taskId, date: plan.date, start: plan.start, end: plan.end, locked: false })
      }
      const actions = [...record.removedBlockIds.map(blockId => ({ type: 'delete-block', id: blockId })),
        ...record.plans.map(({ title: unused, ...plan }) => ({ type: 'save-block', block: { ...plan, locked: false } }))]
      if (!actions.length) fail('这份方案没有可应用的时间变更，待安排事项继续保留', 409)
      const operation = db.applyPlannerOperation({ id: `scenario:${record.id}`, requestId: `scenario:${record.id}`,
        summary: record.decision ? `采用「${record.decision.title}」${record.decision.strategy === 'model' ? '候选路线' : record.decision.strategy === 'defer' ? '明天再做路径' : record.decision.strategy === 'split' ? '今天先做一部分路径' : '今天优先路径'}：本次 7 天安排 ${record.plans.length} 段，${record.unscheduled.length} 项待安排`
          : `应用${record.mode === 'rest' ? '休息' : record.mode === 'light' ? '轻量' : '平衡'}方案：安排 ${record.plans.length} 段，${record.unscheduled.length} 项待安排`,
        actions, expectedRevision: record.baseRevision }, { scenario: true })
      Object.assign(record, { status: 'applied', version: record.version + 1, operationId: operation.id, appliedAt: at.toISOString() })
      save(value)
      return { scenario: record, operation }
    })
  }
  function discardScenario(id, input) {
    knownKeys(input, ['expectedVersion'], '关闭方案')
    return db.transaction(() => {
      const value = state(), record = value.scenarios.find(item => item.id === identifier(id))
      if (!record) fail('找不到这份方案', 404)
      version(record, input.expectedVersion)
      if (record.status !== 'preview') fail('已经应用的方案请使用撤销', 409)
      record.status = 'discarded'; record.version += 1
      save(value)
      return record
    })
  }

  function listState(input = {}) {
    knownKeys(input, ['date', 'days'], '读取陪伴数据')
    const at = clock(), date = day(input.date ?? localDay(at)), days = number(input.days, '查看天数', 1, 7, 7)
    if (!Number.isInteger(days)) fail('天数需要为整数')
    const value = state(), planner = db.getPlanner(), tasks = db.listTasks(), taskMap = new Map(tasks.map(task => [task.id, task]))
    const wishes = value.wishes.filter(item => item.status !== 'deleted' && validSource(item.source)).map(item => ({ ...item,
      status: item.expiresAt && Date.parse(item.expiresAt) <= at.getTime() ? 'expired' : item.status }))
    const freeTimeGoals = value.freeTimeGoals.filter(item => item.status !== 'deleted' && validSource(item.source))
    const operations = new Map(db.listOperations().map(item => [item.id, item]))
    const scenarios = value.scenarios.filter(item => validSource(item.source)).map(item => ({ ...item,
      status: operations.get(item.operationId)?.undoneAt ? 'undone' : item.status }))
    const opportunities = [], timeline = []
    for (const currentDate of datesFrom(date, days)) {
      const capacity = dayCapacity(planner, tasks, currentDate, at)
      timeline.push({ date: currentDate, availableMin: capacity.totalMin, freeMin: capacity.remainingMin, remainingMin: capacity.remainingMin,
        scheduledMin: capacity.scheduledMin,
        blocks: [...routinesForDay(planner, currentDate).map(item => ({ id: item.id, title: item.title, start: item.start, end: item.end, kind: item.kind })),
          ...blocksForDay(planner, tasks, currentDate).map(block => ({ ...block, title: taskMap.get(block.taskId)?.title ?? '', kind: 'task' }))],
        deadlines: tasks.filter(task => active(task) && task.due && (task.due.length === 10 ? task.due : localDay(new Date(task.due))) === currentDate)
          .map(task => ({ taskId: task.id, title: task.title, due: task.due })) })
      for (const wish of wishes.filter(item => item.status === 'active')) {
        if (opportunities.some(item => item.wishId === wish.id)) continue
        const slot = capacity.remaining.find(range => Math.ceil(range.start / 5) * 5 + 5 + wish.minutes <= Math.floor(range.end) - 5)
        if (slot && (!wish.expiresAt || instant(currentDate, timeOf(Math.ceil(slot.start / 5) * 5 + 5 + wish.minutes)) <= Date.parse(wish.expiresAt))) opportunities.push({ id: `wish:${wish.id}:${currentDate}`, kind: 'wish', wishId: wish.id, title: wish.content,
          date: currentDate, start: timeOf(Math.ceil(slot.start / 5) * 5 + 5),
          end: timeOf(Math.ceil(slot.start / 5) * 5 + 5 + wish.minutes), items: wish.items,
          needsConfirmation: true, reason: `${currentDate} 有明确空闲${wish.minutesEstimated ? '，暂按30分钟试留' : ''}，是否适合这件事${wish.items.length ? '及所需条件' : ''}还需你确认`,
          source: wish.source })
      }
      const carry = carryItems(planner, tasks, currentDate).filter(item => !item.checked)
      if (carry.length) opportunities.push({ id: `carry:${currentDate}`, kind: 'carry', date: currentDate, title: '出门前的准备',
        reason: '根据当天课表、任务准备与明确的学习条件整理', items: carry.map(item => item.label ?? item.name ?? item.key),
        source: { kind: 'planner' } })
    }
    return { handoffs: value.handoffs.filter(item => validSource(item.source) && taskMap.has(item.taskId)), wishes, freeTimeGoals, ...freeTimeState(db, { date, days, now: at }), scenarios, opportunities, timeline }
  }
  return { listState, saveHandoff, clearHandoff, saveWish, updateWish, saveFreeTimeGoal, updateFreeTimeGoal, previewScenario, previewDecision, saveRouteScenario, applyScenario, discardScenario }
}
