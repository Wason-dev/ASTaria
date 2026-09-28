export type FreeTimePlanResult = {
  sessions: Array<{ id: string; date: string }>
  addedSessions: Array<{ id: string; date: string }>
  shortfalls: Array<{ goalId: string; title: string; required: number; scheduled: number; reason: string }>
  operation: { id: string } | null
}

export function freeTimeScheduleNotice(result: FreeTimePlanResult): string {
  const count = result.addedSessions.length
  if (count) return `已新增 ${count} 段余时安排，已同步到日程${result.shortfalls.length ? `；${result.shortfalls.length} 项目标尚未排满，原因见下方` : ''}`
  if (result.shortfalls.length) return `本次没有新增安排：${result.shortfalls.map(item => `${item.title}：${item.reason}`).join('；')}`
  return result.sessions.length ? '未来七天已有安排覆盖目标频率，本次没有新增时段' : '本次没有新增安排；目标暂无待补频率或已暂停'
}

export const FREE_TIME_STATUS_LABEL = {
  active: '自动安排中', paused: '已暂停', dropped: '事项已放下', done: '事项已完成', missing: '事项已移除',
} as const
