import { isTaskStep, taskSteps } from '../src/domain/taskSteps.ts'
import { ValidationError, knownKeys, identifier, text, dateTime } from './validation.mjs'

/** Prepare an AI proposal without allowing it to forge or discard checked work. */
export function prepareTaskSteps(task, inputs, makeId) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 30) throw new ValidationError('请提供 1–30 个任务步骤')
  const old = taskSteps(task)
  if (task.subSteps !== undefined && (!Array.isArray(task.subSteps) || old.length !== task.subSteps.length)) {
    throw new ValidationError('这条任务含有旧格式或重复标识的步骤，请先整理旧步骤后再拆分', 409)
  }
  const existing = new Map(old.map(step => [step.id, step]))
  const titles = new Set(), explicitIds = new Set()
  const proposed = inputs.map(input => {
    knownKeys(input, ['id', 'title', 'detail'], '任务步骤')
    const title = text(input.title, '步骤名称', 160)
    const detail = text(input.detail, '步骤说明', 600, { optional: true, empty: true })
    const id = input.id === undefined ? undefined : identifier(input.id, '步骤标识')
    if (titles.has(title)) throw new ValidationError('步骤名称不能重复')
    titles.add(title)
    if (id !== undefined) {
      if (!existing.has(id)) throw new ValidationError('指定的步骤不存在，请重新读取任务后再拆分', 409)
      if (explicitIds.has(id)) throw new ValidationError('步骤标识不能重复')
      explicitIds.add(id)
    }
    return { id, title, detail }
  })
  const usedIds = new Set()
  const steps = proposed.map((input, index) => {
    const previous = input.id === undefined
      ? old.find(step => step.title === input.title && !usedIds.has(step.id) && !explicitIds.has(step.id))
      : existing.get(input.id)
    const id = previous?.id ?? identifier(makeId(index), '步骤标识')
    if (usedIds.has(id) || (!previous && existing.has(id))) throw new ValidationError('步骤标识不能重复')
    usedIds.add(id)
    return {
      id, title: input.title,
      ...(input.detail !== undefined ? { detail: input.detail } : previous?.detail !== undefined ? { detail: previous.detail } : {}),
      ...(previous?.doneAt ? { doneAt: previous.doneAt } : {}),
    }
  })
  // An omitted step may carry real work. Keep it until a deliberate user edit.
  for (const step of old) if (!usedIds.has(step.id)) steps.push({ ...step })
  if (new Set(steps.map(step => step.title)).size !== steps.length) throw new ValidationError('步骤名称与保留的旧步骤重复，请使用原步骤标识修改')
  if (steps.length > 100) throw new ValidationError('保留原有进度后步骤超过 100 项，请先整理旧步骤')
  return steps
}

/** The transaction covers both the version check and the entire task update. */
export function toggleTaskStep(db, input) {
  knownKeys(input, ['taskId', 'stepId', 'checked', 'expectedUpdatedAt'], '步骤勾选')
  const taskId = identifier(input.taskId, '任务标识')
  const stepId = identifier(input.stepId, '步骤标识')
  if (typeof input.checked !== 'boolean') throw new ValidationError('步骤勾选状态必须是布尔值')
  const expectedUpdatedAt = dateTime(input.expectedUpdatedAt, '任务版本')
  if (!expectedUpdatedAt.includes('T')) throw new ValidationError('任务版本需要完整时间')
  return db.transaction(() => {
    const task = db.getTask(taskId)
    if (!task) throw new ValidationError('找不到这条任务', 404)
    if (task.deletedAt || task.status === 'dropped') throw new ValidationError('已删除或放弃的任务不能勾选步骤', 409)
    if (task.updatedAt !== expectedUpdatedAt) throw new ValidationError('任务已在其他窗口修改，请刷新后重试', 409)
    const matches = (task.subSteps ?? []).filter(step => isTaskStep(step) && step.id === stepId)
    if (!matches.length) throw new ValidationError('找不到这个任务步骤', 404)
    if (matches.length !== 1) throw new ValidationError('任务步骤标识重复，请先整理步骤', 409)
    const current = matches[0]
    if (Boolean(current.doneAt) === input.checked) return task
    const subSteps = task.subSteps.map(step => {
      if (step !== current) return step
      const next = { ...current }
      if (input.checked) next.doneAt = new Date().toISOString()
      else delete next.doneAt
      return next
    })
    return db.updateTask(taskId, { subSteps }, expectedUpdatedAt)
  })
}
