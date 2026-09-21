import { cpus, totalmem, platform, arch } from 'node:os'
import { ValidationError, object, knownKeys, choice } from './validation.mjs'

export const LOCAL_DEFAULT = { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '' }
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

export function validateModelSettings(input) {
  object(input); knownKeys(input, ['provider', 'cloudModel', 'local'])
  choice(input.provider, ['deepseek', 'local'], '模型来源')
  choice(input.cloudModel, cloudModels, '云端模型')
  const local = object(input.local)
  knownKeys(local, ['engine', 'baseUrl', 'model'])
  choice(local.engine, ['ollama', 'lmstudio', 'openai'], '本地服务')
  if (typeof local.model !== 'string' || local.model.length > 200 || /[\x00-\x1f\x7f]/u.test(local.model)) throw new ValidationError('模型名称不正确')
  return { provider: input.provider, cloudModel: input.cloudModel, local: { engine: local.engine, baseUrl: localEndpoint(local.baseUrl), model: local.model.trim() } }
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
  const size = device.memoryGB < 12 ? '3B–4B' : device.memoryGB < 24 ? '7B–8B' : device.memoryGB < 48 ? '14B' : '24B–32B'
  return { ...device, acceleration: unified ? 'Apple Silicon 统一内存；加速取决于本地服务的 Metal 配置' : '未检测独立显存；CPU / GPU 加速由本地服务决定', recommendations: [
    { size, label: '建议从这里开始', fit: 'recommended', reason: `按 ${device.memoryGB} GB 系统内存估算，优先选 Q4 量化的指令模型，并保留系统与对话上下文余量。` },
    { size: device.memoryGB < 12 ? '1B–3B' : '3B–4B', label: '更轻、更省资源', fit: 'lighter', reason: '适合短对话；复杂排程和多步骤工具调用更容易出错，先测试工具兼容性。' },
  ], note: '这是容量建议，未进行推理测速，也不代表模型一定可靠。可考虑支持工具调用的 Qwen3 指令模型；在本地服务中加载模型并设置至少 16K 上下文，长对话建议 32K。更长上下文会增加内存占用。ASTaria 不会自动下载模型或回退到云端。' }
}
