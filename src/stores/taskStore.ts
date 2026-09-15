import Dexie, { type Table } from 'dexie'
import { SEED_AREAS } from '../domain/task'
import type { Area, AreaId, Task, TaskDraft, TaskFilter } from '../domain/task'

export interface TaskStore {
  listTasks(filter?: TaskFilter): Promise<Task[]>
  getTask(id: string): Promise<Task | null>
  createTask(draft: TaskDraft): Promise<Task>
  updateTask(id: string, patch: Partial<Task>): Promise<Task>
  deleteTask(id: string): Promise<void>
}

export interface AreaStore {
  listAreas(): Promise<Area[]>
  createArea(name: string, defaultEnergy?: Area['defaultEnergy']): Promise<Area>
  renameArea(id: AreaId, name: string): Promise<Area>
}

class AstariaDatabase extends Dexie {
  tasks!: Table<Task, string>
  areas!: Table<Area, string>

  constructor() {
    super('astaria-local')
    this.version(1).stores({
      tasks: 'id, inbox, area, status, createdAt, updatedAt, deletedAt',
      areas: 'id, name, updatedAt, deletedAt',
    })
  }
}

const db = new AstariaDatabase()

const now = () => new Date().toISOString()
const id = () => crypto.randomUUID()

const clone = <T>(value: T): T => structuredClone(value)

export class LocalTaskStore implements TaskStore {
  async listTasks(filter: TaskFilter = {}): Promise<Task[]> {
    const rows = await db.tasks.toArray()
    return rows
      .filter((task) => {
        if (!filter.includeDeleted && task.deletedAt) return false
        if (filter.inbox !== undefined && task.inbox !== filter.inbox) return false
        if (filter.area !== undefined && task.area !== filter.area) return false
        if (filter.status !== undefined && task.status !== filter.status) return false
        if (filter.visibleAt && task.surfaceAt && task.surfaceAt > filter.visibleAt && (!task.due || task.due > filter.visibleAt)) return false
        return true
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone)
  }

  async getTask(taskId: string): Promise<Task | null> {
    const task = await db.tasks.get(taskId)
    return task ? clone(task) : null
  }

  async createTask(draft: TaskDraft): Promise<Task> {
    const timestamp = now()
    const task: Task = {
      ...draft,
      id: id(),
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: draft.deletedAt ?? null,
    }
    await db.tasks.add(task)
    return clone(task)
  }

  async updateTask(taskId: string, patch: Partial<Task>): Promise<Task> {
    const current = await db.tasks.get(taskId)
    if (!current) throw new Error('找不到这条任务')
    const next: Task = { ...current, ...patch, id: current.id, updatedAt: now() }
    await db.tasks.put(next)
    return clone(next)
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.updateTask(taskId, { deletedAt: now() })
  }
}

export class LocalAreaStore implements AreaStore {
  async listAreas(): Promise<Area[]> {
    const existing = await db.areas.toArray()
    if (existing.length === 0) {
      const timestamp = now()
      const seeded: Area[] = SEED_AREAS.map((area) => ({
        ...area,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
      }))
      await db.areas.bulkPut(seeded)
      return seeded.map(clone)
    }
    return existing
      .filter((area) => !area.deletedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone)
  }

  async createArea(name: string, defaultEnergy: Area['defaultEnergy'] = 'deep'): Promise<Area> {
    const timestamp = now()
    const area: Area = {
      id: `custom-${crypto.randomUUID()}`,
      name,
      defaultEnergy,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    }
    await db.areas.add(area)
    return clone(area)
  }

  async renameArea(areaId: AreaId, name: string): Promise<Area> {
    const current = await db.areas.get(areaId)
    if (!current) throw new Error('找不到这个 Area')
    const area = { ...current, name, updatedAt: now() }
    await db.areas.put(area)
    return clone(area)
  }
}

export const taskStore: TaskStore = new LocalTaskStore()
export const areaStore: AreaStore = new LocalAreaStore()
