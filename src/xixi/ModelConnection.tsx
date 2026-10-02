import { useEffect, useRef, useState } from 'react'
import { localApi } from './api'
import type { ContextBudgetSettings, LocalDevice, LocalModel, LocalModelEngine, LocalStatus, ModelConnectionTest, ProviderSettings, ReasoningEffort } from './types'
import { LocalModelInstaller } from './LocalModelInstaller'
import { withRecommendedLocalModel } from './modelConnectionDefaults'
import './ModelConnection.css'

const LOCAL_ENGINES: Record<LocalModelEngine, { label: string; baseUrl: string }> = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  openai: { label: 'OpenAI 兼容', baseUrl: 'http://127.0.0.1:8080/v1' },
}

function fromStatus(status: LocalStatus | null): ProviderSettings {
  return status?.providerSettings ? {
    ...status.providerSettings,
    reasoningEffort: status.providerSettings.reasoningEffort ?? 'low',
    streamResponses: status.providerSettings.streamResponses ?? true,
    contextBudget: status.providerSettings.contextBudget ?? { mode: 'auto', maxUnits: 48_000 },
    webSearch: status.providerSettings.webSearch ?? { enabled: false, maxUses: 2 },
  } : {
    provider: status?.provider ?? 'deepseek', cloudModel: status?.provider === 'local' ? 'deepseek-flash' : status?.model ?? 'deepseek-flash',
    reasoningEffort: 'low',
    streamResponses: true,
    contextBudget: { mode: 'auto', maxUnits: 48_000 },
    webSearch: { enabled: false, maxUses: 2 },
    local: { engine: 'ollama', baseUrl: LOCAL_ENGINES.ollama.baseUrl, model: '' },
  }
}

function validLocalUrl(value: string) {
  try {
    const url = new URL(value)
    const host = value.match(/^https?:\/\/(\[[^\]]+\]|[^/:?#]+)/i)?.[1]?.toLowerCase()
    return ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(host ?? '')
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash
      && ['', '/', '/v1', '/v1/'].includes(url.pathname) && value.length <= 300
  } catch { return false }
}

type Props = { status: LocalStatus | null; busy: boolean; onAction: (operation: () => Promise<unknown>, message: string) => Promise<void> }

export function ModelConnection({ status, busy, onAction }: Props) {
  const saved = JSON.stringify(fromStatus(status))
  const [draft, setDraft] = useState<ProviderSettings>(() => fromStatus(status))
  const [contextBudgetK, setContextBudgetK] = useState(() => String(fromStatus(status).contextBudget.maxUnits / 1000))
  const [key, setKey] = useState('')
  const [models, setModels] = useState<LocalModel[]>([])
  const [modelsNote, setModelsNote] = useState('')
  const [test, setTest] = useState<ModelConnectionTest | null>(null)
  const [device, setDevice] = useState<LocalDevice | null>(null)
  const [deviceError, setDeviceError] = useState('')
  const [deviceRequest, setDeviceRequest] = useState(0)
  const localModelEdited = useRef(false)
  const [pending, setPending] = useState<'save' | 'models' | 'test' | 'key' | null>(null)
  useEffect(() => {
    const next = JSON.parse(saved) as ProviderSettings
    setDraft(next)
    setContextBudgetK(String(next.contextBudget.maxUnits / 1000))
    localModelEdited.current = false
    setTest(null)
  }, [saved])
  useEffect(() => {
    if (draft.provider !== 'local') return
    let current = true
    setDeviceError('')
    void localApi<LocalDevice>('/settings/device').then(value => {
      if (!current) return
      setDevice(value)
      if (!localModelEdited.current) setDraft(previous => withRecommendedLocalModel(previous, value.recommendedModel))
    }).catch(reason => {
      if (current) setDeviceError(reason instanceof Error ? reason.message : '暂时无法读取本机配置')
    })
    return () => { current = false }
  }, [draft.provider, deviceRequest])
  const customBudget = draft.contextBudget.mode === 'custom'
  const contextBudgetValue = Number(contextBudgetK)
  const contextBudgetValid = !customBudget || (contextBudgetK.trim() !== '' && Number.isInteger(contextBudgetValue) && contextBudgetValue >= 8 && contextBudgetValue <= 2048)
  const contextBudgetError = contextBudgetValid ? '' : '请输入 8–2048 之间的整数（K）'
  const dirty = JSON.stringify(draft) !== saved || (customBudget && contextBudgetK !== String(fromStatus(status).contextBudget.maxUnits / 1000))
  const disabled = busy || pending !== null || !status
  const local = draft.provider === 'local'
  const localUrlValid = validLocalUrl(draft.local.baseUrl.trim())
  const recommendedModelPending = local && draft.local.engine === 'ollama' && draft.local.model === device?.recommendedModel
    && (fromStatus(status).local.model !== draft.local.model || fromStatus(status).local.baseUrl !== draft.local.baseUrl)
    && !models.some(model => model.id === draft.local.model)
  const valid = contextBudgetValid && (!local || (localUrlValid && Boolean(draft.local.model.trim()) && !recommendedModelPending))
  const cloudConfigured = status?.cloudConfigured ?? ((status?.provider ?? 'deepseek') === 'deepseek' && status?.configured)
  const recommendation = device?.recommendations.find(item => item.fit === 'recommended')
  const change = (next: ProviderSettings) => { setDraft(next); setTest(null) }
  const changeLocal = (patch: Partial<ProviderSettings['local']>) => {
    if ('model' in patch) localModelEdited.current = true
    change({ ...draft, local: { ...draft.local, ...patch } })
    if ('baseUrl' in patch || 'engine' in patch) { setModels([]); setModelsNote('') }
  }
  const run = async (kind: NonNullable<typeof pending>, operation: () => Promise<unknown>, message: string) => {
    setPending(kind)
    try { await onAction(operation, message) } finally { setPending(null) }
  }
  const save = () => run('save', async () => {
    if (!contextBudgetValid) throw new Error(contextBudgetError)
    if (!valid) throw new Error('请先确认本地模型已安装，再保存连接')
    const value = { ...draft, local: { ...draft.local, baseUrl: draft.local.baseUrl.trim(), model: draft.local.model.trim() } }
    await localApi<LocalStatus>('/settings/provider', value)
  }, '连接设置已保存，下次回复开始使用')
  const testConnection = () => run('test', async () => {
    setTest(null)
    try {
      const result = await localApi<ModelConnectionTest>('/settings/test', {})
      setTest(result)
    } catch (reason) {
      setTest({ ok: false, toolCalling: false, message: reason instanceof Error ? reason.message : '连接测试未完成，请重试' })
      throw reason
    }
  }, '')
  const keySettings = <>
    <form onSubmit={event => { event.preventDefault(); void run('key', async () => { await localApi('/settings/key', { key: key.trim() }); setKey(''); setTest(null) }, '已存入本机钥匙串') }} autoComplete="off">
      <label htmlFor="deepseek-local-key">{cloudConfigured ? '替换 API Key' : 'API Key'}</label>
      <div className="xixi-model-input-action"><input id="deepseek-local-key" name="astaria-connection-secret" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="保存到本机钥匙串，不回显" disabled={disabled} /><button type="submit" disabled={disabled || !key.trim()}>保存密钥</button></div>
    </form>
    <p className="xixi-settings-note">密钥存本机钥匙串。{local ? '联网搜索只发送你明确输入的查询词到 DeepSeek，模型正文仍留在本机。' : '相关对话与事项交给 DeepSeek，测试会产生少量用量。'}</p>
    {cloudConfigured && <button type="button" disabled={disabled} onClick={() => void run('key', async () => { await localApi('/settings/key/remove', {}); setTest(null) }, '已从钥匙串移除密钥')}>移除密钥</button>}
  </>

  return <section className="xixi-model-connection" aria-label="模型连接">
    <div className="xixi-settings-section-title"><h3>连接模型</h3><small>{!status ? '正在连接本机' : dirty ? '修改尚未保存' : status.configured ? '已配置 · 可测试连接' : '等待配置'}</small></div>
    <div className="xixi-model-modes" role="group" aria-label="模型来源">
      <button type="button" aria-pressed={!local} disabled={disabled} onClick={() => change({ ...draft, provider: 'deepseek' })}><strong>API</strong><span>DeepSeek</span></button>
      <button type="button" aria-pressed={local} disabled={disabled} onClick={() => change({ ...draft, provider: 'local' })}><strong>本地模型</strong><span>这台电脑运行</span></button>
    </div>
    {local ? <>
      <div className="xixi-model-engine">
        <label htmlFor="xixi-local-engine">本地服务<select id="xixi-local-engine" value={draft.local.engine} disabled={disabled} onChange={event => {
          const engine = event.target.value as LocalModelEngine
          changeLocal({ engine, baseUrl: LOCAL_ENGINES[engine].baseUrl, model: '' })
        }}>{Object.entries(LOCAL_ENGINES).map(([value, engine]) => <option key={value} value={value}>{engine.label}</option>)}</select></label>
      </div>
      <label htmlFor="xixi-local-model">模型名称</label>
      <div className="xixi-model-input-action"><input id="xixi-local-model" list="xixi-local-models" value={draft.local.model} disabled={disabled} spellCheck={false} autoCapitalize="none" placeholder="读取列表后选择，或填写服务中的模型名称" onChange={event => changeLocal({ model: event.target.value })} /><button type="button" disabled={disabled || !localUrlValid} onClick={() => void run('models', async () => {
        setModels([]); setModelsNote('')
        try {
          const result = await localApi<{ models: LocalModel[] }>('/settings/local/models', { engine: draft.local.engine, baseUrl: draft.local.baseUrl.trim() })
          setModels(result.models)
          setModelsNote(result.models.length ? `读取到 ${result.models.length} 个模型，可在输入框中选择` : '还没有模型，可以在下方安装；其他服务请先加载模型')
        } catch (reason) {
          setModelsNote('未能读取列表，确认服务已启动后重试；也可手写模型名称')
          throw reason
        }
      }, '')}>{pending === 'models' ? '读取中…' : '读取模型'}</button></div>
      <datalist id="xixi-local-models">{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
      {recommendedModelPending && <small className="xixi-model-list-note">已预选本机推荐的 Qwen3；请读取已安装模型，或在下方安装后使用。</small>}
      {modelsNote && <small className="xixi-model-list-note" role="status">{modelsNote}</small>}
      <details className="xixi-model-advanced"><summary>连接地址</summary><label htmlFor="xixi-local-url">服务地址<input id="xixi-local-url" type="url" value={draft.local.baseUrl} disabled={disabled} spellCheck={false} autoCapitalize="none" aria-invalid={!localUrlValid} aria-describedby="xixi-local-address-note" onChange={event => changeLocal({ baseUrl: event.target.value })} /></label><small id="xixi-local-address-note" className="xixi-model-address-note" data-invalid={!localUrlValid}>{localUrlValid ? '仅连接本机，通常无需修改' : '仅支持本机 HTTP / HTTPS 地址，路径为 / 或 /v1'}</small></details>
      {!localUrlValid && <small role="alert">请展开「连接地址」修正本机服务地址</small>}
      {draft.local.engine === 'ollama' ? <details className="xixi-model-install-disclosure"><summary>还没有模型？帮我安装</summary><LocalModelInstaller key={draft.local.baseUrl} baseUrl={draft.local.baseUrl} disabled={disabled || !localUrlValid || !contextBudgetValid} onChoose={model => void run('save', async () => {
        if (!contextBudgetValid) throw new Error(contextBudgetError)
        const value = { ...draft, provider: 'local' as const, local: { ...draft.local, baseUrl: draft.local.baseUrl.trim(), model } }
        await localApi<LocalStatus>('/settings/provider', value)
        setModelsNote('模型已选用，点「测试连接与工具」确认能否执行任务')
      }, '已选用本地模型')} /></details> : <p className="xixi-settings-note">先在 {LOCAL_ENGINES[draft.local.engine].label} 中加载模型，再读取并选择。</p>}
      <div className="xixi-model-search-key"><strong>联网搜索的 DeepSeek Key</strong>{keySettings}</div>
    </> : <>
      <div className="xixi-model-cloud-row"><label htmlFor="xixi-cloud-model">默认模型</label><select id="xixi-cloud-model" aria-label="默认模型" value={draft.cloudModel} disabled={disabled} onChange={event => change({ ...draft, cloudModel: event.target.value })}><option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></select></div>
      <div className="xixi-model-cloud-row xixi-model-thinking-row"><label htmlFor="xixi-reasoning-effort">思考深度</label><select id="xixi-reasoning-effort" value={draft.reasoningEffort} disabled={disabled} aria-describedby="xixi-reasoning-note" onChange={event => change({ ...draft, reasoningEffort: event.target.value as ReasoningEffort })}><option value="low">轻量 Low（默认）</option><option value="high">深入 High</option><option value="max">最高 Max</option><option value="off">关闭</option></select></div>
      <small id="xixi-reasoning-note" className="xixi-model-reasoning-note">{!status ? '默认轻量深度' : draft.reasoningEffort !== fromStatus(status).reasoningEffort ? '思考深度尚未保存' : '思考深度已保存'} · 此设置只影响聊天；弦轨整理始终使用 Low，避免久等</small>
      {cloudConfigured ? <details className="xixi-model-key-manager"><summary>API Key 已保存 · 管理</summary>{keySettings}</details> : <div className="xixi-model-key-setup">{keySettings}</div>}
    </>}
    <div className="xixi-model-web-search">
      <div className="xixi-model-web-search-heading"><strong>联网搜索（可选）</strong><button className="xixi-toggle" type="button" role="switch" aria-label="联网搜索" aria-checked={draft.webSearch.enabled} disabled={disabled} onClick={() => change({ ...draft, webSearch: { ...draft.webSearch, enabled: !draft.webSearch.enabled } })}><span /></button></div>
      <small>打开后，析熙才会调用 DeepSeek 的联网搜索，并且只发送查询词；课表、事项、聊天和记忆不会随搜索请求发送。{local ? '当前正文仍由本地模型处理。' : ''} 默认关闭。</small>
      {draft.webSearch.enabled && <small className="xixi-model-web-search-warning">这是独立的云端通道，会产生网络请求和 DeepSeek 用量；请确认你愿意把查询词交给 DeepSeek。</small>}
    </div>
    <div className="xixi-model-context-budget">
      <div className="xixi-model-cloud-row"><label htmlFor="xixi-context-budget-mode">上下文预算</label><select id="xixi-context-budget-mode" value={draft.contextBudget.mode} disabled={disabled} aria-describedby="xixi-context-budget-note" onChange={event => change({ ...draft, contextBudget: { ...draft.contextBudget, mode: event.target.value as ContextBudgetSettings['mode'] } })}><option value="auto">自动（{local ? '本地 24K' : '云端 48K'}）</option><option value="custom">自定义</option><option value="off">关闭应用限制</option></select></div>
      {customBudget && <div className="xixi-model-budget-custom">
        <label htmlFor="xixi-context-budget-value">预算上限</label>
        <div className="xixi-model-budget-input"><input id="xixi-context-budget-value" type="number" min={8} max={2048} step={1} inputMode="numeric" value={contextBudgetK} disabled={disabled} aria-invalid={!contextBudgetValid} aria-describedby={`xixi-context-budget-note${contextBudgetError ? ' xixi-context-budget-error' : ''}`} onChange={event => {
          const value = event.target.value
          setContextBudgetK(value)
          const parsed = Number(value)
          if (value.trim() && Number.isInteger(parsed) && parsed >= 8 && parsed <= 2048) change({ ...draft, contextBudget: { ...draft.contextBudget, maxUnits: parsed * 1000 } })
          else setTest(null)
        }} /><span>K</span></div>
      </div>}
      {contextBudgetError && <small id="xixi-context-budget-error" className="xixi-model-budget-error" role="alert">{contextBudgetError}</small>}
      <small id="xixi-context-budget-note" className="xixi-model-reasoning-note">{draft.contextBudget.mode === 'off' ? '不做应用内压缩或长度拦截；模型接口仍有实际上限。' : '按估算 token 控制上下文，1K = 1000，并非模型官方精确额度。'} 与连接设置一并保存，下一条消息生效。</small>
    </div>
    <div className="xixi-model-stream"><div><span>流式输出</span><button className="xixi-toggle" type="button" role="switch" aria-label="流式输出" aria-checked={draft.streamResponses} disabled={disabled} onClick={() => change({ ...draft, streamResponses: !draft.streamResponses })}><span /></button></div><small>逐步显示模型返回的思考和回复 · {draft.streamResponses !== fromStatus(status).streamResponses ? '尚未保存' : '已保存'}，下一条消息生效</small></div>
    <div className="xixi-settings-actions xixi-model-actions">
      <button type="button" disabled={disabled || !dirty || !valid} onClick={() => void save()}>{pending === 'save' ? '保存中…' : '保存连接设置'}</button>
      <button type="button" disabled={disabled || dirty || !status?.configured} onClick={() => void testConnection()}>{pending === 'test' ? '测试中…' : local ? '测试连接与工具' : '测试连接'}</button>
      {dirty && <small>保存后即可测试</small>}
    </div>
    {test && <div className="xixi-model-test" role={test.ok && test.toolCalling !== false ? 'status' : 'alert'} data-result={test.ok && test.toolCalling !== false ? 'pass' : 'warning'}><strong>{!test.ok ? '连接测试未通过' : test.toolCalling === null ? '连接成功 · API 可用' : test.toolCalling ? '连接成功 · 工具调用可用' : '已连接 · 工具调用未通过'}</strong><span>{test.message}</span>{test.ok && test.toolCalling === false && <small>请换用支持工具调用的模型并重新测试，任务操作可能无法完成。</small>}</div>}
    {local && <aside className="xixi-model-device" aria-label="本机模型建议">
      <div className="xixi-model-device-summary"><strong>本机建议</strong><span>{device ? `${device.memoryGB} GB 内存${recommendation ? ` · 建议 ${recommendation.size}` : ''}` : deviceError ? '读取暂未完成' : '正在读取设备…'}</span></div>
      {device ? <details><summary>查看配置与建议依据</summary><small>{device.cpu} · {device.logicalCores} 核 · {device.platform} / {device.arch}<br />{device.acceleration}</small><ul>{device.recommendations.map(item => <li key={`${item.fit}:${item.size}`} data-fit={item.fit}><strong>{item.size} · {item.label}</strong><span>{item.reason}</span></li>)}</ul><p className="xixi-settings-note">{device.note}</p></details> : deviceError && <p role="status">{deviceError}<button type="button" disabled={disabled} onClick={() => setDeviceRequest(value => value + 1)}>重试读取</button></p>}
    </aside>}
  </section>
}
