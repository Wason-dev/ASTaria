import { automaticContextBudget } from '../src/xixi/contextBudgetPolicy.ts'
import { ValidationError, object, knownKeys, choice } from './validation.mjs'
import { compatibleEndpoint, CLOUD_PRESETS } from '../src/xixi/cloudProviders.ts'

export const LOCAL_DEFAULT = { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '' }
export const DEFAULT_REASONING_EFFORT = 'low'
export const DEFAULT_STREAM_RESPONSES = true
export const DEFAULT_CONTEXT_BUDGET = { mode: 'auto', maxUnits: 48_000 }
// External search is a separate, explicitly enabled channel. It stays off for
// every new connection, including local-model connections.
export const DEFAULT_WEB_SEARCH = { enabled: false, maxUses: 2 }
export const REASONING_EFFORTS = ['off', 'low', 'high', 'max']
const cloudModels = ['deepseek-flash', 'deepseek-v4-pro']

export function localEndpoint(value) {
  if (typeof value !== 'string' || value.length > 300) throw new ValidationError('请输入本机模型服务地址')
  let url
  try { url = new URL(value) } catch { throw new ValidationError('本机模型地址格式不正确') }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw new ValidationError('仅支持本机 127.0.0.1、localhost 或 [::1] 的 /v1 接口，不要填写密钥')
  }
  // Pin localhost to loopback; never resolve a supplied hostname or follow redirects.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  return `${url.origin}/v1`
}

export function validateContextBudget(value = DEFAULT_CONTEXT_BUDGET) {
  object(value); knownKeys(value, ['mode', 'maxUnits'])
  choice(value.mode, ['auto', 'custom', 'off'], '上下文预算')
  const maxUnits = value.maxUnits ?? DEFAULT_CONTEXT_BUDGET.maxUnits
  if (!Number.isInteger(maxUnits) || maxUnits < 8_000 || maxUnits > 2_048_000 || maxUnits % 1000 !== 0) {
    throw new ValidationError('上下文预算请输入 8–2048 K 的整数')
  }
  return { mode: value.mode, maxUnits }
}

export function resolveContextBudget(settings = {}) {
  const value = validateContextBudget(settings.contextBudget)
  const local = settings.provider === 'local'
  const automatic = automaticContextBudget(settings)
  const hard = value.mode === 'off' ? Infinity : value.mode === 'custom' ? value.maxUnits : automatic.hard
  return { enabled: value.mode !== 'off', soft: value.mode === 'auto' ? automatic.soft : hard * 2 / 3, hard, turns: local ? 4 : 8 }
}

export function validateWebSearch(value = DEFAULT_WEB_SEARCH) {
  object(value, '联网搜索')
  knownKeys(value, ['enabled', 'maxUses'], '联网搜索')
  const enabled = value.enabled === undefined ? DEFAULT_WEB_SEARCH.enabled : value.enabled
  if (typeof enabled !== 'boolean') throw new ValidationError('联网搜索开关不正确')
  const maxUses = value.maxUses === undefined ? DEFAULT_WEB_SEARCH.maxUses : value.maxUses
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 4) throw new ValidationError('联网搜索次数应为 1–4')
  return { enabled, maxUses }
}

export function validateModelSettings(input) {
  object(input); knownKeys(input, ['provider', 'cloudModel', 'reasoningEffort', 'streamResponses', 'contextBudget', 'local', 'webSearch', 'compatible'])
  choice(input.provider, ['deepseek', 'local', 'compatible'], '模型来源')
  choice(input.cloudModel, cloudModels, '云端模型')
  // Older saved connections and backups had no thinking preference. They adopt
  // the new default without losing their selected provider or local endpoint.
  const reasoningEffort = input.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : input.reasoningEffort
  choice(reasoningEffort, REASONING_EFFORTS, '思考深度')
  const streamResponses = input.streamResponses === undefined ? DEFAULT_STREAM_RESPONSES : input.streamResponses
  choice(streamResponses, [true, false], '流式输出')
  const contextBudget = validateContextBudget(input.contextBudget)
  const webSearch = validateWebSearch(input.webSearch)
  const local = object(input.local)
  knownKeys(local, ['engine', 'baseUrl', 'model'])
  choice(local.engine, ['ollama', 'lmstudio', 'openai'], '本地服务')
  if (typeof local.model !== 'string' || local.model.length > 200 || /[\x00-\x1f\x7f]/u.test(local.model)) throw new ValidationError('模型名称不正确')
  let compatible
  if (input.compatible !== undefined || input.provider === 'compatible') {
    const value = object(input.compatible)
    knownKeys(value, ['preset', 'baseUrl', 'model'])
    choice(value.preset, CLOUD_PRESETS.map(preset => preset.id), 'API 服务')
    if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\s\x00-\x1f\x7f]/u.test(value.model)) throw new ValidationError('请填写服务中的准确模型 ID')
    let baseUrl
    try { baseUrl = compatibleEndpoint(value.baseUrl) } catch (error) { throw new ValidationError(error.message) }
    const preset = CLOUD_PRESETS.find(preset => preset.id === value.preset)
    if (preset.id !== 'custom' && preset.baseUrl !== baseUrl) throw new ValidationError('预设服务地址不一致，请改选自定义')
    compatible = { preset: value.preset, baseUrl, model: value.model.trim() }
  }
  return { provider: input.provider, cloudModel: input.cloudModel, reasoningEffort, streamResponses, contextBudget, webSearch, local: { engine: local.engine, baseUrl: localEndpoint(local.baseUrl), model: local.model.trim() }, ...(compatible ? { compatible } : {}) }
}

export function getModelSettings(db) {
  const saved = db.getPreference('model-connection')
  return validateModelSettings(saved ? { ...saved, cloudModel: db.getModel() } : { provider: 'deepseek', cloudModel: db.getModel(), local: LOCAL_DEFAULT })
}

export function saveModelSettings(db, input) {
  const checked = validateModelSettings(input)
  db.transaction(() => { db.setModel(checked.cloudModel); db.setPreference('model-connection', checked) })
  return checked
}
