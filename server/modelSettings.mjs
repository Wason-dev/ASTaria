import { cpus, totalmem, platform, arch } from 'node:os'

// Session validation and budget rules live in modelSettingsCore so a mobile
// build can share them without Node os. This module adds the host probe only.
export * from './modelSettingsCore.mjs'

export function deviceRecommendation(device = { platform: platform(), arch: arch(), memoryGB: Math.round(totalmem() / 1024 ** 3), cpu: cpus()[0]?.model || '未知处理器', logicalCores: cpus().length }) {
  const unified = device.platform === 'darwin' && device.arch === 'arm64'
  const size = device.memoryGB < 16 ? '4B' : device.memoryGB < 24 ? '8B' : device.memoryGB < 48 ? '14B' : '32B'
  const recommendedModel = device.memoryGB >= 8 ? `qwen3:${size.toLowerCase()}` : null
  return { ...device, recommendedModel, recommendedContextTokens: 32768, acceleration: unified ? 'Apple Silicon 统一内存；加速取决于本地服务的 Metal 配置' : '未检测独立显存；CPU / GPU 加速由本地服务决定', recommendations: [
    ...(recommendedModel ? [{ size, label: `Qwen3 ${size} · 建议从这里开始`, fit: 'recommended', reason: `按 ${device.memoryGB} GB 系统内存估算，优先选 Q4 量化，并保留系统与对话上下文余量。` }] : []),
    { size: device.memoryGB < 12 ? '1B–3B' : '3B–4B', label: '更轻、更省资源', fit: 'lighter', reason: '适合短对话；复杂排程和多步骤工具调用更容易出错，先测试工具兼容性。' },
  ], note: `${recommendedModel ? '默认推荐支持工具调用的 Qwen3。' : '本机内存不足 8 GB，暂不默认推荐本地模型，可使用 API。'}这是容量建议，未进行推理测速；建议在本地服务中设置 32K 上下文，并为上下文保留内存。模型能力需通过连接与工具测试确认。下载需你确认，本地失败不会回退到云端。` }
}
