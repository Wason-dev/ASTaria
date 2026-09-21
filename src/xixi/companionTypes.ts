export type CompanionMode = 'rebalance' | 'rest' | 'light'
export type CompanionSource = { kind: 'user' | 'conversation' | 'planner'; messageId?: string; evidence?: string }

export type Handoff = {
  taskId: string
  progress: string
  obstacle: string
  nextStep: string
  materials: string[]
  version: number
  source: CompanionSource
  createdAt: string
  updatedAt: string
}

export type Wish = {
  id: string
  content: string
  evidence: string
  minutes: number
  minutesEstimated?: boolean
  items: string[]
  expiresAt?: string | null
  status: 'active' | 'paused' | 'deleted' | 'expired'
  version: number
  source: CompanionSource
  createdAt: string
  updatedAt: string
}

export type ScenarioPlan = { id: string; taskId: string; title: string; date: string; start: string; end: string }
export type DecisionStrategy = 'today' | 'split' | 'defer'
export type DecisionRecurrence = 'once' | 'weekly'
export type DecisionInput = { date: string; taskId: string; strategy: DecisionStrategy; recurrence: DecisionRecurrence; todayMin?: number }
export type ScenarioDecision = {
  taskId: string
  title: string
  strategy: DecisionStrategy
  recurrence: DecisionRecurrence
  todayMin: number
  effortMin: number | null
  baseline: ScenarioPlan[]
}
export type CompanionScenario = {
  id: string
  version: number
  status: 'preview' | 'applied' | 'discarded' | 'undone'
  baseRevision: number
  date: string
  days: number
  mode: CompanionMode
  decision?: ScenarioDecision
  plans: ScenarioPlan[]
  removedBlockIds: string[]
  unscheduled: Array<{ taskId: string; title: string; reason: string; remainingMin: number | null }>
  warnings: string[]
  taskVersions: Record<string, string>
  metrics?: { scheduledMin: number; unscheduledMin: number; bufferMin: number }
  createdAt: string
  operationId?: string
}

export type CompanionOpportunity = {
  id: string
  kind: 'wish' | 'carry'
  title: string
  reason: string
  date: string
  start?: string
  end?: string
  wishId?: string
  items?: string[]
  source: CompanionSource
}

export type CompanionDay = {
  date: string
  availableMin: number
  freeMin: number
  scheduledMin: number
  remainingMin: number
  blocks: Array<{ id: string; taskId?: string; title: string; start: string; end: string; kind: 'task' | 'class' | 'break' | 'available' }>
  deadlines: Array<{ taskId: string; title: string; due: string }>
}

export type CompanionState = {
  handoffs: Handoff[]
  wishes: Wish[]
  scenarios: CompanionScenario[]
  opportunities: CompanionOpportunity[]
  timeline: CompanionDay[]
}
