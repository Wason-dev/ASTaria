import type { Area, AreaId, Task, TaskDraft, TaskFilter } from '../domain/task'
import { localApi } from '../xixi/api'
import { ensureLocalMigration, notifyLocalDataChange } from './migration'

export interface TaskStore {
  listTasks(filter?: TaskFilter): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  createTask(draft: TaskDraft): Promise<Task>
  updateTask(id: string, patch: Partial<Task>, expectedUpdatedAt?: string): Promise<Task>
  reopenTask(id: string, expectedUpdatedAt: string): Promise<Task>
  deleteTask(id: string): Promise<void>
}
export interface AreaStore {
  listAreas(): Promise<Area[]>
  createArea(name: string, defaultEnergy?: Area['defaultEnergy']): Promise<Area>
  renameArea(id: AreaId, name: string): Promise<Area>
}
export class LocalTaskStore implements TaskStore {
  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    await ensureLocalMigration()
    return localApi<Task[]>(`/tasks?filter=${encodeURIComponent(JSON.stringify(filter))}`)
  }
  async getTask(id: string): Promise<Task | null> {
    await ensureLocalMigration()
    return localApi<Task | null>(`/tasks/${encodeURIComponent(id)}`)
  }
  async createTask(draft: TaskDraft): Promise<Task> {
    await ensureLocalMigration()
    const task = await localApi<Task>('/tasks/create', draft)
    notifyLocalDataChange()
    return task
  }
  async updateTask(id: string, patch: Partial<Task>, expectedUpdatedAt?: string): Promise<Task> {
    await ensureLocalMigration()
    const task = await localApi<Task>('/tasks/update', { id, patch, expectedUpdatedAt })
    notifyLocalDataChange()
    return task
  }
  async reopenTask(id: string, expectedUpdatedAt: string): Promise<Task> {
    await ensureLocalMigration()
    const task = await localApi<Task>('/tasks/reopen', { id, expectedUpdatedAt })
    notifyLocalDataChange()
    return task
  }
  async deleteTask(id: string): Promise<void> {
    await ensureLocalMigration()
    await localApi('/tasks/delete', { id })
    notifyLocalDataChange()
  }
}
export class LocalAreaStore implements AreaStore {
  async listAreas(): Promise<Area[]> {
    await ensureLocalMigration()
    return localApi<Area[]>('/areas')
  }
  async createArea(name: string, defaultEnergy: Area['defaultEnergy'] = 'deep'): Promise<Area> {
    await ensureLocalMigration()
    const area = await localApi<Area>('/areas/create', { name, defaultEnergy })
    notifyLocalDataChange()
    return area
  }
  async renameArea(id: AreaId, name: string): Promise<Area> {
    await ensureLocalMigration()
    const area = await localApi<Area>('/areas/rename', { id, name })
    notifyLocalDataChange()
    return area
  }
}
export const taskStore: TaskStore = new LocalTaskStore()
export const areaStore: AreaStore = new LocalAreaStore()
