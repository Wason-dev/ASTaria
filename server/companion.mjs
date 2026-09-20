import { randomUUID } from 'node:crypto'
import { ValidationError, knownKeys, text, identifier, choice, day, dateTime, number } from './validation.mjs'
import { dayCapacity, carryItems, blocksForDay, routinesForDay, minuteOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'

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
  const state = () => db.getCompanionState()
  const save = value => {
    if (value.wishes.length > 500 || value.handoffs.length > 2000 || value.scenarios.length > 100) fail('本地记录较多，请先清理旧记录', 409)
    return db.saveCompanionState(value)
  }
  const validSource = source => source?.kind !== 'conversation' || (() => {
    const message = db.getMessage(source.messageId)
    return message && !message.excludeFromContext && !message.retractedAt
  })()
  const sourceValue = (source, evidence) => {
    if (!source || source.kind === 'user') return { kind: 'user', ...(evidence ? { evidence } : {}) }
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
      const movable = planner.blocks.filter(block => selectedIds.has(block.taskId) && dates.includes(block.date) &&
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
      for (const blockId of record.removedBlockIds) {
        const block = planner.blocks.find(item => item.id === blockId)
        if (!block || block.locked || instant(block.date, block.start) < at.getTime()) fail('原安排已经锁定、开始或变化，请重新推演', 409)
      }
      const working = { ...planner, blocks: planner.blocks.filter(block => !record.removedBlockIds.includes(block.id)) }
      for (const plan of record.plans) {
        const task = requireTask(plan.taskId), start = minuteOf(plan.start), end = minuteOf(plan.end)
        if (!active(task) || instant(plan.date, plan.start) < at.getTime()) fail('任务状态或时间已有变化，请重新推演', 409)
        if (instant(plan.date, plan.end) > deadline(task)) fail('方案超过了任务DDL，请重新推演', 409)
        const capacity = dayCapacity(working, tasks, plan.date, at)
        if (!capacity.remaining.some(range => range.start <= start && range.end >= end)) fail('方案已不在明确的可用空闲中，请重新推演', 409)
        working.blocks.push({ id: plan.id, taskId: plan.taskId, date: plan.date, start: plan.start, end: plan.end, locked: false })
      }
      const actions = [...record.removedBlockIds.map(blockId => ({ type: 'delete-block', id: blockId })),
        ...record.plans.map(({ title: unused, ...plan }) => ({ type: 'save-block', block: { ...plan, locked: false } }))]
      if (!actions.length) fail('这份方案没有可应用的时间变更，待安排事项继续保留', 409)
      const operation = db.applyPlannerOperation({ id: `scenario:${record.id}`, requestId: `scenario:${record.id}`,
        summary: `应用${record.mode === 'rest' ? '休息' : record.mode === 'light' ? '轻量' : '平衡'}方案：安排 ${record.plans.length} 段，${record.unscheduled.length} 项待安排`,
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
    return { handoffs: value.handoffs.filter(item => validSource(item.source) && taskMap.has(item.taskId)), wishes, scenarios, opportunities, timeline }
  }
  return { listState, saveHandoff, clearHandoff, saveWish, updateWish, previewScenario, applyScenario, discardScenario }
}
