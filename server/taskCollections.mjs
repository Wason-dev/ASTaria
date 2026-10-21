import { identifier, knownKeys, taskInput, ValidationError } from './validation.mjs'

/** Build one atomic, undoable metadata edit. Schedule and task identity stay intact. */
export function taskCollectionChanges(db, input, at = new Date().toISOString()) {
  knownKeys(input, ['tasks', 'collection', 'removeTasks'])
  if (!Object.hasOwn(input, 'collection')) throw new ValidationError('请填写集合名称或选择移出集合')
  const collection = taskInput({ collection: input.collection }, { partial: true }).collection
  const removed = input.removeTasks ?? []
  if (!Array.isArray(input.tasks) || !Array.isArray(removed) || !input.tasks.length && !removed.length || input.tasks.length + removed.length > 50) throw new ValidationError('请选择 1–50 项事项')
  const seen = new Set()
  const changes = [...input.tasks.map(ref => ({ ref, name: collection })), ...removed.map(ref => ({ ref, name: undefined }))].map(({ ref, name }) => {
    knownKeys(ref, ['id', 'expectedUpdatedAt'])
    const id = identifier(ref.id, '事项标识')
    if (seen.has(id)) throw new ValidationError('同一事项不能重复归类')
    seen.add(id)
    const before = db.getTask(id)
    if (!before || before.deletedAt) throw new ValidationError('事项已不存在，请重新读取', 409)
    if (ref.expectedUpdatedAt !== before.updatedAt) throw new ValidationError('事项已在其他窗口更新，请重新读取后再归类', 409)
    const after = { ...before, updatedAt: new Date(Math.max(Date.parse(at), Date.parse(before.updatedAt) + 1)).toISOString() }
    if (name) after.collection = name
    else delete after.collection
    return { table: 'tasks', id, before, after }
  })
  return { changes, summary: collection && input.tasks.length ? `将 ${input.tasks.length} 项事项归入「${collection}」${removed.length ? ` · 移出 ${removed.length} 项` : ''}` : `将 ${changes.length} 项事项移出集合` }
}
