export type LocalModelEngine = 'ollama' | 'lmstudio' | 'openai'
export type ReasoningEffort = 'off' | 'low' | 'high' | 'max'
export type ContextBudgetSettings = { mode: 'auto' | 'custom' | 'off'; maxUnits: number }
export type WebSearchSettings = { enabled: boolean; maxUses: number }
export type ProviderSettings = { provider: 'deepseek' | 'local' | 'compatible'; compatible?: import('./cloudProviders').CompatibleConnection; cloudModel: string; reasoningEffort: ReasoningEffort; streamResponses: boolean; contextBudget: ContextBudgetSettings; webSearch: WebSearchSettings; local: { engine: LocalModelEngine; baseUrl: string; model: string } }
export type LocalStatus = {
  contextModelKey?: string; contextCapacity?: number | null
  configured: boolean; service: 'astaria-local'; model: string; storage: 'SQLite'; dataDirectory: string
  provider?: ProviderSettings['provider']; cloudConfigured?: boolean | null; compatibleConfigured?: boolean; providerSettings?: ProviderSettings; secretStorage?: string
}
export type LocalModel = { id: string; label: string }
export type ModelConnectionTest = { ok: boolean; toolCalling: boolean | null; message: string }
export type DeviceRecommendation = { size: string; label: string; reason: string; fit: 'recommended' | 'lighter' | 'larger' }
export type LocalDevice = {
  platform: string; arch: string; memoryGB: number; cpu: string; logicalCores: number; acceleration: string
  recommendedModel: string | null; recommendedContextTokens: number
  recommendations: DeviceRecommendation[]; note: string
}
export type ExecutionNotice = { issues: string[]; replyUnavailable?: true }
export type { SourceMetadata } from './sourceMetadata'
import type { SourceMetadata } from './sourceMetadata'
export type ChatMessage = { id: string; seq: number; role: 'user' | 'assistant' | 'tool'; content: string; inputKind?: 'receipt-estimate'; attachments?: ChatAttachment[]; reasoningContent?: string; hasSavedReasoning?: boolean; executionNotice?: ExecutionNotice; sources?: SourceMetadata[]; createdAt: string; requestId?: string; taskId?: string; excludeFromContext?: boolean; delivery?: 'sending' | 'failed'; question?: { options: string[] }; retractedAt?: string }
export type ReceiptTask = { id: string; title: string; collection?: string; status?: string; due?: string; estimateMin?: number; updatedAt: string }
export type Operation = { id: string; requestId: string; summary: string; createdAt: string; readAt: string | null; undoneAt: string | null; undoable?: boolean; undoLabel?: string; relatedOperationIds?: string[]; scheduledCount?: number; details?: string[]; createdTasks?: ReceiptTask[] }
export type CompanionAction = { id: string; requestId: string; kind: 'scenario' | 'handoff' | 'wish' | 'goal'; label: string; targetId?: string; createdAt: string }
export type ConversationState = { conversationId: string; messages: ChatMessage[]; operations: Operation[]; companionActions?: CompanionAction[]; oldestSeq?: number | null; hasOlder?: boolean; contextUsage?: import('./contextUsage').ContextUsage | null }
export type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt?: string }
export type ChatResult = ConversationState & { requestId: string; status: 'completed' | 'failed'; error?: string; execution?: { status?: string; reply?: { mode?: string }; commits?: unknown[]; failures?: unknown[] } }
export type ChatStreamPhase = 'thinking' | 'replying' | 'executing'
export type ChatStreamActivity = {
  id: string
  stage: 'reading' | 'searching' | 'thinking' | 'planning' | 'saving' | 'asking'
  state: 'running' | 'done' | 'failed'
  title: string
  detail?: string
}
export type ChatStreamEvent = { type: 'round'; round: number }
  | { type: 'context-usage'; usage: import('./contextUsage').ContextUsage }
  | { type: 'thinking-title'; round: number; title: string }
  | { type: 'reasoning' | 'content'; round: number; delta: string }
  | { type: 'phase'; phase: ChatStreamPhase }
  | { type: 'activity'; activity: ChatStreamActivity }
  | { type: 'sources'; sources: SourceMetadata[] }
  | { type: 'result'; result: ChatResult }
  | { type: 'error'; error: string }
export type ChatReasoningRound = { id: string; content: string; round?: number }
export type SavedReasoning = { reasoningContent: string; rounds?: ChatReasoningRound[]; roundCount?: number; status?: 'running' | 'completed' | 'failed' }
export type ChatStreamDraft = { requestId: string; conversationId: string; round: number; reasoningContent: string; reasoningRounds?: ChatReasoningRound[]; thinkingTitle?: string; content: string; phase: ChatStreamPhase; activities?: ChatStreamActivity[]; sources?: SourceMetadata[]; contextUsage?: import('./contextUsage').ContextUsage }
export type Memory = { id: string; content: string; scope: 'global' | 'task'; kind: 'preference' | 'project' | 'context'; lifetime?: 'temporary' | 'long-term' | 'inference'; taskId?: string; sourceMessageId: string; expiresAt?: string | null; createdAt: string; updatedAt: string }
export type ChatImageAttachment = { kind?: 'image'; name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; size: number; data: string }
export type ChatAttachment = ChatImageAttachment | import('./documentAttachment').ChatDocumentAttachment
export type ChatMessageAttachment = ChatAttachment
