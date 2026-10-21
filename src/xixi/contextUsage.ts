export type ContextUsage = {
  modelKey: string; model: string; capacity: number | null
  inputTokens: number; outputTokens: number; usedTokens: number
  source: 'provider' | 'estimate'; updatedAt: string
}
export function isContextUsage(value: unknown): value is ContextUsage {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.modelKey === 'string' && /^[a-f0-9]{64}$/.test(item.modelKey)
    && typeof item.model === 'string' && item.model.length > 0 && item.model.length <= 200
    && (item.capacity === null || Number.isSafeInteger(item.capacity) && Number(item.capacity) > 0)
    && ['inputTokens', 'outputTokens', 'usedTokens'].every(key => Number.isSafeInteger(item[key]) && Number(item[key]) >= 0)
    && Number(item.inputTokens) + Number(item.outputTokens) === item.usedTokens
    && (item.source === 'provider' || item.source === 'estimate')
    && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
}
