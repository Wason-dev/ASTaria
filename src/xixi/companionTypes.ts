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
  clarification?: { motivation?: string; firstStep?: string }
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

export type FreeTimeGoal = {
  id: string
  title: string
  evidence: string
  priority: 'high' | 'normal' | 'low'
  minPerWeek: number
  sessionMin: number
  sessionMax: number
  taskId?: string
  targetDate?: string | null
  targetNote?: string
  fromWishId?: string
  status: 'active' | 'paused' | 'deleted'
  version: number
  source: CompanionSource
  createdAt: string
  updatedAt: string
}

export type FreeTimeSession = { id: string; goalId: string; taskId: string; title: string; date: string; start: string; end: string; locked: boolean; completed: boolean }
export type FreeTimeProgress = { goalId: string; schedulingStatus: 'active' | 'paused'; taskUpdatedAt: string | null; scheduledCount: number; completedCount: number; scheduledMin: number; completedMin: number; required: number; remainingCount: number; shortSessionCount: number }

export type ScenarioPlan = { id: string; taskId: string; title: string; date: string; start: string; end: string }
export type DecisionStrategy = 'today' | 'split' | 'defer' | 'model'
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
  routeAnalysis?: RouteAnalysis
  plans: ScenarioPlan[]
  removedBlockIds: string[]
  unscheduled: Array<{ taskId: string; title: string; reason: string; remainingMin: number | null }>
  warnings: string[]
  taskVersions: Record<string, string>
  metrics?: { scheduledMin: number; unscheduledMin: number; bufferMin: number }
  createdAt: string
  operationId?: string
}

export type RouteHorizon = 'week' | 'fourWeeks' | 'threeMonths' | 'oneYear'
export type RouteAnalysis = {
  question: string
  current: string
  candidate: string
  benefits: string[]
  costs: string[]
  risks: string[]
  recovery: string[]
  observations: string[]
  assumptions: string[]
  trends: Record<RouteHorizon, { condition: string; summary: string; uncertainty: string }>
  facts: {
    task: { id: string; title: string; due?: string; estimateMin?: number; status: string }
    baseline: ScenarioPlan[]
    candidate: ScenarioPlan[]
    verified: string[]
    timeline: CompanionDay[]
    availableWindows: Array<{ date: string; start: string; end: string }>
    effortMin: number | null
    heldMin: number
    remainingMin: number | null
    bufferMin: number
    baseRevision: number
    asOf: string
  }
  kind: 'model-judgment'
  conditional: true
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
  freeTimeGoals: FreeTimeGoal[]
  freeTimeSessions: FreeTimeSession[]
  freeTimeProgress: FreeTimeProgress[]
  freeTimeBreaks: Array<{ date: string; start: string; end: string }>
  freeTimeFeedback: Array<{ sessionId: string; goalId: string; date: string; minutes: number; feedback: 'smooth' | 'stuck' | 'continue'; nextStep: string; completedAt: string }>
  scenarios: CompanionScenario[]
  opportunities: CompanionOpportunity[]
  timeline: CompanionDay[]
}
