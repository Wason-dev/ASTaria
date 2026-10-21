import type { Task } from './task'

type Member = Pick<Task, 'id' | 'title' | 'due' | 'collection'> & Partial<Pick<Task, 'status' | 'estimateMin' | 'deletedAt'>>
export type TaskCollection<T extends Member = Task> = { kind: 'collection'; id: string; name: string; due?: string; tasks: T[]; visible: T[] }
export type TaskEntry<T extends Member = Task> = { kind: 'task'; id: string; task: T } | TaskCollection<T>

// Membership is explicit. Similar titles, matching dates and tool batch IDs
// never establish a theme. Exact instants and date-only DDLs stay distinct.
export function taskCollectionKey(task: Pick<Member, 'collection' | 'due'>): string | null {
  const name = task.collection?.trim()
  if (!name) return null
  const due = task.due?.includes('T') && Number.isFinite(Date.parse(task.due)) ? new Date(task.due).toISOString() : task.due ?? ''
  return `collection:${JSON.stringify([name, due])}`
}

export function taskEntries<T extends Member>(visible: T[], all: T[] = visible): TaskEntry<T>[] {
  const membership = new Map<string, T[]>()
  for (const task of all) {
    const key = taskCollectionKey(task)
    if (!key || task.deletedAt || task.status === 'dropped') continue
    const members = membership.get(key) ?? []
    members.push(task); membership.set(key, members)
  }
  const result: TaskEntry<T>[] = [], groups = new Map<string, TaskCollection<T>>()
  for (const task of visible) {
    if (task.deletedAt || task.status === 'dropped') continue
    const key = taskCollectionKey(task)
    if (!key) { result.push({ kind: 'task', id: task.id, task }); continue }
    let group = groups.get(key)
    if (!group) {
      group = { kind: 'collection', id: key, name: task.collection!.trim(), due: task.due, tasks: membership.get(key) ?? [task], visible: [] }
      groups.set(key, group); result.push(group)
    }
    group.visible.push(task)
  }
  return result
}

export function collectionProgress(group: TaskCollection<Member>): string {
  return `${group.tasks.length} 项 · 已完成 ${group.tasks.filter(task => task.status === 'done').length}/${group.tasks.length}`
}

export function collectionRemaining(group: TaskCollection<Member>): string {
  const pending = group.tasks.filter(task => task.status !== 'done')
  const known = pending.reduce((sum, task) => sum + (task.estimateMin ?? 0), 0)
  const unknown = pending.filter(task => !task.estimateMin).length
  return [known ? `剩余估时 ${known} 分钟` : '', unknown ? `${unknown} 项用时待估` : ''].filter(Boolean).join(' · ') || '全部完成'
}
