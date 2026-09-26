import type { OrbitGroup } from './orbitGroups'

export const HORIZON_GROUP_CAPACITY = 6
export const HORIZON_GROUP_TITLE_LIMIT = 80

export type HorizonGroupingResult =
  | { ok: true; groups: OrbitGroup[]; focusGroupId: string }
  | { ok: false; reason: string }

const success = (groups: readonly OrbitGroup[], focusGroupId: string): HorizonGroupingResult => ({ ok: true, groups: [...groups], focusGroupId })
const failure = (reason: string): HorizonGroupingResult => ({ ok: false, reason })

export function renameHorizonGroup(groups: readonly OrbitGroup[], groupId: string, name: string): HorizonGroupingResult {
  const group = groups.find(item => item.id === groupId)
  if (!group) return failure('这组已不在当前草稿中，请重新选择。')
  const title = name.trim()
  if (!title) return failure('给这组留一个名字。')
  if ([...title].length > HORIZON_GROUP_TITLE_LIMIT) return failure('组名最多 80 个字，请缩短一些。')
  return success(groups.map(item => item.id === groupId && title !== item.title ? { ...item, title } : item), groupId)
}

/** Append the source to a same-day destination, retaining the destination's identity. */
export function mergeHorizonGroups(groups: readonly OrbitGroup[], sourceId: string, targetId: string): HorizonGroupingResult {
  const source = groups.find(group => group.id === sourceId), target = groups.find(group => group.id === targetId)
  if (!source || !target) return failure('要合并的组已变化，请重新选择。')
  if (sourceId === targetId) return success(groups, targetId)
  if (source.day !== target.day) return failure('合并需要在同一天；跨天可以逐项移入目标组。')
  if (source.tasks.length + target.tasks.length > HORIZON_GROUP_CAPACITY) return failure('每组最多 6 项，这两组合并后会超出。可以先移动部分事项。')
  const targetIds = new Set(target.tasks.map(task => task.id))
  if (source.tasks.some(task => targetIds.has(task.id))) return failure('两组里有重复事项，暂时无法合并。请重新读取安排。')
  return success(groups.filter(group => group.id !== sourceId).map(group => group.id === targetId ? { ...group, tasks: [...target.tasks, ...source.tasks] } : group), targetId)
}

/** Move the original task object, including its scheduling metadata, to another group. */
export function moveHorizonTaskToGroup(groups: readonly OrbitGroup[], sourceId: string, taskId: string, targetId: string): HorizonGroupingResult {
  const source = groups.find(group => group.id === sourceId), target = groups.find(group => group.id === targetId)
  if (!source || !target) return failure('来源组或目标组已变化，请重新选择。')
  const task = source.tasks.find(item => item.id === taskId)
  if (!task) return failure('这项已经移走，请到它所在的组继续调整。')
  if (sourceId === targetId) return success(groups, sourceId)
  if (target.tasks.length >= HORIZON_GROUP_CAPACITY) return failure('目标组已有 6 项，请选择另一组，或先让一项独立成组。')
  if (target.tasks.some(item => item.id === taskId)) return failure('目标组里已有这项，暂时无法移动。请重新读取安排。')
  return success(groups.map(group => group.id === sourceId
    ? { ...group, tasks: group.tasks.filter(item => item.id !== taskId) }
    : group.id === targetId ? { ...group, tasks: [...group.tasks, task] } : group).filter(group => group.tasks.length > 0), targetId)
}

/** The ID factory is injectable for deterministic tests; ordinary edits use a UUID. */
export function splitHorizonTask(groups: readonly OrbitGroup[], groupId: string, taskId: string, createId = () => `horizon-custom-${crypto.randomUUID()}`): HorizonGroupingResult {
  const index = groups.findIndex(group => group.id === groupId), source = groups[index]
  if (!source) return failure('这组已不在当前草稿中，请重新选择。')
  const task = source.tasks.find(item => item.id === taskId)
  if (!task) return failure('这项已经移走，请到它所在的组继续调整。')
  if (source.tasks.length === 1) return success(groups, groupId)
  const id = createId()
  if (!id || groups.some(group => group.id === id)) return failure('新组没有创建成功，请重试。')
  const result = [...groups]
  result.splice(index, 1, { ...source, tasks: source.tasks.filter(item => item.id !== taskId) }, {
    id, title: [...task.title].slice(0, HORIZON_GROUP_TITLE_LIMIT).join(''), day: source.day,
    ...(source.project ? { project: source.project } : {}), tasks: [task],
  })
  return success(result, id)
}
