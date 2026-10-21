import { contextUnits } from './contextBudget.mjs'
import { sha256Hex } from './portable.mjs'
export const contextMeterKey = conversationId => `context-meter-${sha256Hex(conversationId)}`

export function contextModel(settings) {
  const provider = settings.provider ?? 'deepseek'
  const model = provider === 'local' ? settings.local?.model : provider === 'compatible' ? settings.compatible?.model : settings.cloudModel
  const endpoint = provider === 'local' ? settings.local?.baseUrl : provider === 'compatible' ? settings.compatible?.baseUrl : 'deepseek-official'
  return { model, modelKey: sha256Hex(JSON.stringify([provider, endpoint, model])),
    // Product convention: one full ring is 1M tokens for the DeepSeek models.
    // A custom/local model's unknown window must not be invented from its name.
    capacity: provider === 'deepseek' ? 1_000_000 : null }
}
const count = value => Number.isSafeInteger(value) && value >= 0
export function measureContext(payload, settings, result, now = () => new Date()) {
  const usage = result?.usage
  const exact = count(usage?.prompt_tokens) && count(usage?.completion_tokens)
    && Number.isSafeInteger(usage.prompt_tokens + usage.completion_tokens)
  const inputTokens = exact ? usage.prompt_tokens : contextUnits({ messages: payload.messages, ...(payload.tools ? { tools: payload.tools } : {}) })
  const outputTokens = exact ? usage.completion_tokens : result?.choices?.[0]?.message ? contextUnits(result.choices[0].message) : 0
  return { ...contextModel(settings), inputTokens, outputTokens, usedTokens: inputTokens + outputTokens,
    source: exact ? 'provider' : 'estimate', updatedAt: now().toISOString() }
}
