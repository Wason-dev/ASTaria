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
  { id: 'l-and-l', name: 'L&L', defaultEnergy: 'deep' },
  { id: 'business', name: '商务', defaultEnergy: 'deep' },
  { id: 'phy2', name: 'Phy2', defaultEnergy: 'deep' },
  { id: 'agentic-ai', name: 'AgenticAI', defaultEnergy: 'deep' },
  { id: 'sat', name: 'SAT', defaultEnergy: 'deep' },
  { id: 'words', name: '单词', defaultEnergy: 'light' },
  { id: 'project-moss', name: '个人项目：MOSS', defaultEnergy: 'deep' },
  { id: 'project-psec', name: '个人项目：PSEC-WEB', defaultEnergy: 'deep' },
  { id: 'project-vfx', name: '个人项目：VFX', defaultEnergy: 'deep' },
  { id: 'cas', name: 'CAS', defaultEnergy: 'light' },
]
