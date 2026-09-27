export type AreaId = string

export type ContextTag =
  | 'anywhere'
  | 'library'
  | 'desk-4090'
  | 'desk-mac'
  | 'physical'

export type TaskStatus = 'todo' | 'doing' | 'done' | 'dropped'

export type Task = {
  id: string
  title: string
  notes?: string
  area: AreaId | null
  source: 'manual' | 'ai' | 'import' | 'recurring'
  inbox: boolean
  due?: string
  startAt?: string
  estimateMin?: number
  freeTimeGoalId?: string
  occurrence?: {
    seriesId: string
    date: string
    preferredWindow?: string
    allowFallback: boolean
    placement: 'start' | 'end'
  }
  subSteps?: unknown[]
  surfaceAt?: string
  leadDays: number
  importance: 1 | 2 | 3
  energy: 'deep' | 'light'
  context: ContextTag[]
  fuzzyWindow?: 'today' | 'this-week' | 'someday'
  status: TaskStatus
  doneAt?: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type TaskDraft = Omit<
  Task,
  'id' | 'createdAt' | 'updatedAt' | 'deletedAt'
> & {
  deletedAt?: string | null
}

export type TaskFilter = {
  inbox?: boolean
  area?: AreaId
  status?: TaskStatus
  includeDeleted?: boolean
  visibleAt?: string
}

export type Area = {
  id: AreaId
  name: string
  defaultEnergy: 'deep' | 'light'
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export const SEED_AREAS: Array<Pick<Area, 'id' | 'name' | 'defaultEnergy'>> = [
  { id: 'math', name: '数学', defaultEnergy: 'deep' },
  { id: 'chinese', name: '语文', defaultEnergy: 'deep' },
  { id: 'english', name: '英语', defaultEnergy: 'deep' },
  { id: 'physics', name: '物理', defaultEnergy: 'deep' },
  { id: 'work', name: '工作', defaultEnergy: 'deep' },
  { id: 'life', name: '生活', defaultEnergy: 'light' },
  { id: 'projects', name: '项目', defaultEnergy: 'deep' },
]
