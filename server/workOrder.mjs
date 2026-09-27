/**
 * Durable execution state for one assistant request.
 *
 * Model text is not a commit signal. Operation receipts record committed
 * writes; pending or failed steps keep the overall execution incomplete even
 * when the reply channel has produced a successful response.
 */
export function createWorkOrder(input, previous = null, clock = () => new Date().toISOString()) {
  const old = previous?.progress
  const order = old && old.requestId === input.requestId
    ? structuredClone(old)
    : { version: 0, requestId: input.requestId, conversationId: input.conversationId,
      userMessageId: input.userMessageId, status: 'running', reply: { mode: 'pending' },
      steps: [], commits: [], failures: [], createdAt: clock() }
  const save = () => { order.version += 1; order.updatedAt = clock(); return structuredClone(order) }
  return {
    get value() { return order },
    step(toolCallId, name, operationId) {
      const existing = order.steps.find(step => step.toolCallId === toolCallId)
      if (existing) {
        if (operationId && !existing.operationId) { existing.operationId = operationId; save() }
        return existing
      }
      const step = { id: `${order.requestId}:${order.steps.length + 1}`, toolCallId, name, status: 'running',
        ...(operationId ? { operationId } : {}) }
      order.steps.push(step); save(); return step
    },
    commit(step, operation) {
      step.status = 'committed'; step.operationId = operation?.id
      delete step.error
      // A corrected call has a new call ID but commits the same intended write.
      const recovered = new Set([step.id])
      for (const previous of order.steps) if (operation?.id && previous.status === 'failed' && previous.operationId === operation.id) {
        previous.status = 'recovered'; previous.resolvedByStepId = step.id; recovered.add(previous.id)
      }
      order.failures = order.failures.filter(failure => !recovered.has(failure.stepId))
      order.commits = [...new Map(order.commits.concat({ stepId: step.id, operationId: operation?.id, summary: operation?.summary }).filter(item => item.operationId).map(item => [item.operationId, item])).values()]
      order.status = 'running'; save()
    },
    succeed(step) {
      if (step.status !== 'committed') step.status = 'completed'
      delete step.error
      order.failures = order.failures.filter(failure => failure.stepId !== step.id)
      save()
    },
    fail(step, error) {
      step.status = 'failed'; step.error = String(error ?? '操作未完成').slice(0, 240)
      order.failures = order.failures.filter(failure => failure.stepId !== step.id)
      order.failures.push({ stepId: step.id, error: step.error }); order.status = order.commits.length ? 'partial' : 'failed'; save()
    },
    pending(reason) { order.pending = String(reason).slice(0, 240); save() },
    clearPending() { delete order.pending; save() },
    expectSchedule(taskId, minutes, reason, constraints = {}) {
      order.scheduleRequirements ??= []
      const requirement = { taskId, minutes, reason: String(reason).slice(0, 240), ...constraints, status: 'pending' }
      const index = order.scheduleRequirements.findIndex(item => item.taskId === taskId)
      if (index < 0) order.scheduleRequirements.push(requirement)
      else order.scheduleRequirements[index] = requirement
      save()
    },
    checkSchedules(allocatedMinutes) {
      for (const item of order.scheduleRequirements ?? []) item.status = (allocatedMinutes.get(item.taskId) ?? 0) >= item.minutes ? 'verified' : 'pending'
      save()
    },
    checkScheduleBlocks(blocks, tasks, today) {
      const byId = new Map(tasks.map(task => [task.id, task]))
      const minute = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
      for (const requirement of order.scheduleRequirements ?? []) {
        if (requirement.status === 'cancelled') continue
        const task = byId.get(requirement.taskId)
        const eligible = !task || task.deletedAt || task.status === 'dropped' ? [] : blocks.filter(block =>
          block.taskId === requirement.taskId && block.date >= today &&
          (!requirement.date || block.date === requirement.date) &&
          (!task.startAt || block.date >= task.startAt.slice(0, 10)) &&
          (!task.due || (task.due.length === 10 ? block.date <= task.due : new Date(`${block.date}T${block.end}:00`).getTime() <= Date.parse(task.due))))
        // Verify exact declared appointments separately from general allocations.
        // Overlapping blocks cannot inflate the amount of scheduled work.
        const ranges = eligible.map(block => ({ date: block.date, start: minute(block.start), end: minute(block.end) }))
          .sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)
        let total = 0, date, end = 0
        for (const range of ranges) {
          if (date !== range.date) { date = range.date; end = 0 }
          total += Math.max(0, range.end - Math.max(end, range.start)); end = Math.max(end, range.end)
        }
        // Verify the request's allocation below, not the latest editable
        // estimate: a shortcut edit must not invalidate an already saved slot.
        const occurrenceValid = !task?.occurrence || (eligible.length === 1 && eligible[0].date === task.occurrence.date)
        const verified = occurrenceValid && (requirement.slot
          ? eligible.some(block => block.date === requirement.slot.date && block.start === requirement.slot.start && block.end === requirement.slot.end)
          : total >= requirement.minutes && (!requirement.slots?.length ||
            requirement.slots.every(slot => eligible.some(block => block.date === slot.date && block.start === slot.start && block.end === slot.end))))
        requirement.status = verified ? 'verified' : 'pending'
      }
      save()
    },
    expectPlans(plans) {
      for (const taskId of new Set(plans.map(plan => plan.taskId))) {
        order.scheduleRequirements ??= []
        const existing = order.scheduleRequirements.find(item => item.taskId === taskId)
        // The user's declared appointment remains authoritative when the model
        // writes a different time; a write receipt cannot redefine the goal.
        if (existing?.slot || existing?.status === 'cancelled') continue
        const slots = [...(existing?.slots ?? [])]
        for (const plan of plans.filter(plan => plan.taskId === taskId)) {
          const index = slots.findIndex(slot => slot.id === plan.id)
          if (index < 0) slots.push({ ...plan }); else slots[index] = { ...plan }
        }
        const next = { ...existing, taskId, minutes: existing?.minutes ?? 1, slots,
          mustComplete: true, reason: existing?.reason ?? `${plans.find(plan => plan.taskId === taskId)?.title ?? taskId}：已提交的日历时段与当前状态不一致`, status: 'pending' }
        if (existing) Object.assign(existing, next); else order.scheduleRequirements.push(next)
      }
      save()
    },
    cancelSchedule(taskId) {
      for (const item of order.scheduleRequirements ?? []) if (item.taskId === taskId) item.status = 'cancelled'
      save()
    },
    expectEvents(events) {
      order.eventRequirements ??= []
      for (const { id, title, date, start, end } of events) {
        const existing = order.eventRequirements.find(item => item.id === id)
        // An undo is final for this request; replaying an earlier receipt must
        // not revive a cancelled event or invite the model to create it again.
        if (existing?.status === 'cancelled') continue
        const requirement = { id, title, date, start, end,
          reason: `${title}：${date} ${start}–${end} 已保存的活动与当前日历不一致`, status: 'pending' }
        if (existing) Object.assign(existing, requirement)
        else order.eventRequirements.push(requirement)
      }
      save()
    },
    checkEvents(events) {
      const byId = new Map(events.map(event => [event.id, event]))
      for (const requirement of order.eventRequirements ?? []) {
        if (requirement.status === 'cancelled') continue
        const current = byId.get(requirement.id)
        requirement.status = current && ['id', 'title', 'date', 'start', 'end'].every(key => current[key] === requirement[key])
          ? 'verified' : 'pending'
      }
      save()
    },
    cancelEvent(id) {
      for (const item of order.eventRequirements ?? []) if (item.id === id) item.status = 'cancelled'
      save()
    },
    interrupt(reason) { order.interrupted = String(reason).slice(0, 240); save() },
    resume() { order.reply = { mode: 'pending' }; order.status = 'running'; save() },
    clearInterruption() { delete order.interrupted; save() },
    awaiting(reason) { order.status = 'awaiting_user'; order.pending = String(reason).slice(0, 240); save() },
    verify() {
      if (order.failures.length || order.pending || order.interrupted || order.steps.some(step => step.status === 'running') || order.scheduleRequirements?.some(item => item.status === 'pending') || order.eventRequirements?.some(item => item.status === 'pending')) order.status = order.commits.length ? 'partial' : 'failed'
      else if (order.commits.length) order.status = 'verified'
      else order.status = 'completed'
      save(); return order.status
    },
    finishReply(mode, error) { order.reply = { mode, ...(error ? { error: String(error).slice(0, 240) } : {}) }; save() },
    snapshot() { return structuredClone(order) },
  }
}
