export type LocalStatus = { configured: boolean; service: 'astaria-local'; model: string; storage: 'SQLite'; dataDirectory: string }
export type ChatMessage = { id: string; seq: number; role: 'user' | 'assistant' | 'tool'; content: string; createdAt: string; requestId?: string; taskId?: string; excludeFromContext?: boolean; delivery?: 'sending' | 'failed'; question?: { options: string[] }; retractedAt?: string }
export type Operation = { id: string; requestId: string; summary: string; createdAt: string; readAt: string | null; undoneAt: string | null; undoable?: boolean; details?: string[] }
export type CompanionAction = { id: string; requestId: string; kind: 'scenario' | 'handoff' | 'wish'; label: string; targetId?: string; createdAt: string }
export type ConversationState = { conversationId: string; messages: ChatMessage[]; operations: Operation[]; companionActions?: CompanionAction[]; oldestSeq?: number | null; hasOlder?: boolean }
export type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt?: string }
export type ChatResult = ConversationState & { requestId: string; status: 'completed' | 'failed'; error?: string }
export type Memory = { id: string; content: string; scope: 'global' | 'task'; kind: 'preference' | 'project' | 'context'; lifetime?: 'temporary' | 'long-term' | 'inference'; taskId?: string; sourceMessageId: string; expiresAt?: string | null; createdAt: string; updatedAt: string }
