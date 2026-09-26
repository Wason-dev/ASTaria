export type OrbitDay = 0 | 1 | 2

export type OrbitTask = {
  id: string
  title: string
  minutes: number
  needsReschedule?: boolean
}

export type OrbitGroup = {
  id: string
  title: string
  day: OrbitDay
  project?: string
  tasks: OrbitTask[]
}

// Visual prototype sample data only; these groups are not the user's actual plans.
// Each group belongs to one day. Project names are optional context, not containers.
export const ORBIT_DEMO_GROUPS: readonly OrbitGroup[] = [
  {
    id: 'orbit-today-review', title: '把方案再打磨一下', day: 0, project: '产品设计',
    tasks: [
      { id: 'orbit-task-review-notes', title: '整理昨天的反馈', minutes: 20 },
      { id: 'orbit-task-review-flow', title: '调整首页交互流程', minutes: 45 },
      { id: 'orbit-task-review-preview', title: '导出一版预览', minutes: 15 },
    ],
  },
  {
    id: 'orbit-today-study', title: '留一点时间给阅读', day: 0,
    tasks: [
      { id: 'orbit-task-study-read', title: '读完这一章', minutes: 30 },
      { id: 'orbit-task-study-notes', title: '记下三个有用的想法', minutes: 10 },
    ],
  },
  {
    id: 'orbit-today-life', title: '照顾好日常', day: 0,
    tasks: [
      { id: 'orbit-task-life-walk', title: '出门散步', minutes: 25 },
      { id: 'orbit-task-life-tidy', title: '收拾桌面', minutes: 10 },
    ],
  },
  {
    id: 'orbit-tomorrow-interview', title: '准备一次用户访谈', day: 1, project: '产品设计',
    tasks: [
      { id: 'orbit-task-interview-outline', title: '梳理访谈提纲', minutes: 30 },
      { id: 'orbit-task-interview-material', title: '准备演示材料', minutes: 25 },
      { id: 'orbit-task-interview-check', title: '检查录音和会议链接', minutes: 10 },
    ],
  },
  {
    id: 'orbit-tomorrow-writing', title: '让文章有个开头', day: 1, project: '个人写作',
    tasks: [
      { id: 'orbit-task-writing-outline', title: '列出文章提纲', minutes: 20 },
      { id: 'orbit-task-writing-draft', title: '写一段初稿', minutes: 40 },
    ],
  },
  {
    id: 'orbit-tomorrow-movement', title: '活动一下身体', day: 1,
    tasks: [
      { id: 'orbit-task-movement-run', title: '轻松跑三公里', minutes: 30 },
      { id: 'orbit-task-movement-stretch', title: '做一组拉伸', minutes: 10 },
    ],
  },
  {
    id: 'orbit-later-refine', title: '把访谈变成下一步', day: 2, project: '产品设计',
    tasks: [
      { id: 'orbit-task-refine-notes', title: '整理访谈记录', minutes: 30 },
      { id: 'orbit-task-refine-insights', title: '归纳关键发现', minutes: 25 },
      { id: 'orbit-task-refine-next', title: '列出下一版要改的地方', minutes: 20 },
    ],
  },
  {
    id: 'orbit-later-weekend', title: '给周末腾出空间', day: 2,
    tasks: [
      { id: 'orbit-task-weekend-supplies', title: '补齐家里的日用品', minutes: 25 },
      { id: 'orbit-task-weekend-plan', title: '选一条周末散步路线', minutes: 15 },
    ],
  },
]

export function cloneOrbitGroups(): OrbitGroup[] {
  return ORBIT_DEMO_GROUPS.map(group => ({
    ...group,
    tasks: group.tasks.map(task => ({ ...task })),
  }))
}

export function orbitDayGroups(groups: readonly OrbitGroup[], day: OrbitDay): OrbitGroup[] {
  return groups.filter(group => group.day === day)
}

export function groupMinutes(group: OrbitGroup): number {
  return group.tasks.reduce((total, task) => total + task.minutes, 0)
}

function boundedIndex(index: number, length: number): number {
  return Number.isNaN(index) ? 0 : Math.max(0, Math.min(length, Math.trunc(index)))
}

/** The destination index is within its day, after the moved group is removed. */
export function moveOrbitGroup(
  groups: readonly OrbitGroup[], id: string, day: OrbitDay, index: number,
): OrbitGroup[] {
  const sourceIndex = groups.findIndex(group => group.id === id)
  const result = [...groups]
  if (sourceIndex < 0) return result

  const [source] = result.splice(sourceIndex, 1)
  const targetIndices = result.flatMap((group, position) => group.day === day ? [position] : [])
  const destination = boundedIndex(index, targetIndices.length)
  let insertion: number

  if (destination < targetIndices.length) {
    insertion = targetIndices[destination]
  } else if (targetIndices.length > 0) {
    insertion = targetIndices[targetIndices.length - 1] + 1
  } else {
    // An empty day gets its own place in the chronological list.
    const followingDay = result.findIndex(group => group.day > day)
    insertion = followingDay < 0 ? result.length : followingDay
  }

  result.splice(insertion, 0, source.day === day ? source : { ...source, day })
  return result
}

/** Tasks can be reordered only inside their current group. */
export function moveOrbitTask(
  groups: readonly OrbitGroup[], groupId: string, taskId: string, index: number,
): OrbitGroup[] {
  const groupIndex = groups.findIndex(group => group.id === groupId)
  const result = [...groups]
  if (groupIndex < 0) return result

  const group = groups[groupIndex]
  const taskIndex = group.tasks.findIndex(task => task.id === taskId)
  if (taskIndex < 0) return result

  const tasks = [...group.tasks]
  const [task] = tasks.splice(taskIndex, 1)
  tasks.splice(boundedIndex(index, tasks.length), 0, task)
  result[groupIndex] = { ...group, tasks }
  return result
}
