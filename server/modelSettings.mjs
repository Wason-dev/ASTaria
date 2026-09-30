import { cpus, totalmem, platform, arch } from 'node:os'
import { ValidationError, object, knownKeys, choice } from './validation.mjs'

export const LOCAL_DEFAULT = { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '' }
export const DEFAULT_REASONING_EFFORT = 'low'
export const DEFAULT_STREAM_RESPONSES = true
export const DEFAULT_CONTEXT_BUDGET = { mode: 'auto', maxUnits: 48_000 }
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
  const hard = value.mode === 'off' ? Infinity : value.mode === 'custom' ? value.maxUnits : local ? 24_000 : 48_000
  return { enabled: value.mode !== 'off', soft: hard * 2 / 3, hard, turns: local ? 4 : 8 }
}

export function validateModelSettings(input) {
  object(input); knownKeys(input, ['provider', 'cloudModel', 'reasoningEffort', 'streamResponses', 'contextBudget', 'local'])
  choice(input.provider, ['deepseek', 'local'], '模型来源')
  choice(input.cloudModel, cloudModels, '云端模型')
  // Older saved connections and backups had no thinking preference. They adopt
  // the new default without losing their selected provider or local endpoint.
  const reasoningEffort = input.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : input.reasoningEffort
  choice(reasoningEffort, REASONING_EFFORTS, '思考深度')
  const streamResponses = input.streamResponses === undefined ? DEFAULT_STREAM_RESPONSES : input.streamResponses
  choice(streamResponses, [true, false], '流式输出')
  const contextBudget = validateContextBudget(input.contextBudget)
  const local = object(input.local)
  knownKeys(local, ['engine', 'baseUrl', 'model'])
  choice(local.engine, ['ollama', 'lmstudio', 'openai'], '本地服务')
  if (typeof local.model !== 'string' || local.model.length > 200 || /[\x00-\x1f\x7f]/u.test(local.model)) throw new ValidationError('模型名称不正确')
  return { provider: input.provider, cloudModel: input.cloudModel, reasoningEffort, streamResponses, contextBudget, local: { engine: local.engine, baseUrl: localEndpoint(local.baseUrl), model: local.model.trim() } }
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

export function deviceRecommendation(device = { platform: platform(), arch: arch(), memoryGB: Math.round(totalmem() / 1024 ** 3), cpu: cpus()[0]?.model || '未知处理器', logicalCores: cpus().length }) {
  const unified = device.platform === 'darwin' && device.arch === 'arm64'
  const size = device.memoryGB < 16 ? '4B' : device.memoryGB < 24 ? '8B' : device.memoryGB < 48 ? '14B' : '32B'
  const recommendedModel = device.memoryGB >= 8 ? `qwen3:${size.toLowerCase()}` : null
  return { ...device, recommendedModel, recommendedContextTokens: 32768, acceleration: unified ? 'Apple Silicon 统一内存；加速取决于本地服务的 Metal 配置' : '未检测独立显存；CPU / GPU 加速由本地服务决定', recommendations: [
    ...(recommendedModel ? [{ size, label: `Qwen3 ${size} · 建议从这里开始`, fit: 'recommended', reason: `按 ${device.memoryGB} GB 系统内存估算，优先选 Q4 量化，并保留系统与对话上下文余量。` }] : []),
    { size: device.memoryGB < 12 ? '1B–3B' : '3B–4B', label: '更轻、更省资源', fit: 'lighter', reason: '适合短对话；复杂排程和多步骤工具调用更容易出错，先测试工具兼容性。' },
  ], note: `${recommendedModel ? '默认推荐支持工具调用的 Qwen3。' : '本机内存不足 8 GB，暂不默认推荐本地模型，可使用 API。'}这是容量建议，未进行推理测速；建议在本地服务中设置 32K 上下文，并为上下文保留内存。模型能力需通过连接与工具测试确认。下载需你确认，本地失败不会回退到云端。` }
}
