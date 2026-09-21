import { useEffect, useState } from 'react'
import { localApi } from './api'
import type { LocalDevice, LocalModel, LocalModelEngine, LocalStatus, ModelConnectionTest, ProviderSettings } from './types'
import './ModelConnection.css'

const LOCAL_ENGINES: Record<LocalModelEngine, { label: string; baseUrl: string }> = {
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  openai: { label: 'OpenAI 兼容', baseUrl: 'http://127.0.0.1:8080/v1' },
}

function fromStatus(status: LocalStatus | null): ProviderSettings {
  return status?.providerSettings ?? {
    provider: status?.provider ?? 'deepseek', cloudModel: status?.provider === 'local' ? 'deepseek-flash' : status?.model ?? 'deepseek-flash',
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
  const [key, setKey] = useState('')
  const [models, setModels] = useState<LocalModel[]>([])
  const [modelsNote, setModelsNote] = useState('')
  const [test, setTest] = useState<ModelConnectionTest | null>(null)
  const [device, setDevice] = useState<LocalDevice | null>(null)
  const [deviceError, setDeviceError] = useState('')
  const [deviceRequest, setDeviceRequest] = useState(0)
  const [pending, setPending] = useState<'save' | 'models' | 'test' | 'key' | null>(null)
  useEffect(() => { setDraft(JSON.parse(saved) as ProviderSettings); setTest(null) }, [saved])
  useEffect(() => {
    if (draft.provider !== 'local') return
    let current = true
    setDeviceError('')
    void localApi<LocalDevice>('/settings/device').then(value => { if (current) setDevice(value) }).catch(reason => {
      if (current) setDeviceError(reason instanceof Error ? reason.message : '暂时无法读取本机配置')
    })
    return () => { current = false }
  }, [draft.provider, deviceRequest])
  const dirty = JSON.stringify(draft) !== saved
  const disabled = busy || pending !== null || !status
  const local = draft.provider === 'local'
  const localUrlValid = validLocalUrl(draft.local.baseUrl.trim())
  const valid = !local || (localUrlValid && Boolean(draft.local.model.trim()))
  const cloudConfigured = status?.cloudConfigured ?? ((status?.provider ?? 'deepseek') === 'deepseek' && status?.configured)
  const recommendation = device?.recommendations.find(item => item.fit === 'recommended')
  const change = (next: ProviderSettings) => { setDraft(next); setTest(null) }
  const changeLocal = (patch: Partial<ProviderSettings['local']>) => {
    change({ ...draft, local: { ...draft.local, ...patch } })
    if ('baseUrl' in patch || 'engine' in patch) { setModels([]); setModelsNote('') }
  }
  const run = async (kind: NonNullable<typeof pending>, operation: () => Promise<unknown>, message: string) => {
    setPending(kind)
    try { await onAction(operation, message) } finally { setPending(null) }
  }
  const save = () => run('save', async () => {
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

  return <section className="xixi-model-connection" aria-label="模型连接">
    <div className="xixi-settings-section-title"><h3>连接模型</h3><small>{!status ? '正在连接本机' : dirty ? '修改尚未保存' : status.configured ? '已配置 · 可测试连接' : '等待配置'}</small></div>
    <div className="xixi-model-modes" role="group" aria-label="模型来源">
      <button type="button" aria-pressed={!local} disabled={disabled} onClick={() => change({ ...draft, provider: 'deepseek' })}><strong>API</strong><span>DeepSeek</span></button>
      <button type="button" aria-pressed={local} disabled={disabled} onClick={() => change({ ...draft, provider: 'local' })}><strong>本地模型</strong><span>这台电脑运行</span></button>
    </div>
    {local ? <>
      <div className="xixi-model-fields">
        <label htmlFor="xixi-local-engine">本地服务<select id="xixi-local-engine" value={draft.local.engine} disabled={disabled} onChange={event => {
          const engine = event.target.value as LocalModelEngine
          changeLocal({ engine, baseUrl: LOCAL_ENGINES[engine].baseUrl, model: '' })
        }}>{Object.entries(LOCAL_ENGINES).map(([value, engine]) => <option key={value} value={value}>{engine.label}</option>)}</select></label>
        <label htmlFor="xixi-local-url">服务地址<input id="xixi-local-url" type="url" value={draft.local.baseUrl} disabled={disabled} spellCheck={false} autoCapitalize="none" aria-invalid={!localUrlValid} aria-describedby="xixi-local-address-note" onChange={event => changeLocal({ baseUrl: event.target.value })} /></label>
      </div>
      <small id="xixi-local-address-note" className="xixi-model-address-note" data-invalid={!localUrlValid}>{localUrlValid ? '仅连接本机：127.0.0.1、localhost 或 [::1]，路径为 / 或 /v1' : '请填写本机 HTTP / HTTPS 地址，路径为 / 或 /v1，不含账号、查询参数或片段'}</small>
      <label htmlFor="xixi-local-model">模型名称</label>
      <div className="xixi-model-input-action"><input id="xixi-local-model" list="xixi-local-models" value={draft.local.model} disabled={disabled} spellCheck={false} autoCapitalize="none" placeholder="读取列表后选择，或填写服务中的模型名称" onChange={event => changeLocal({ model: event.target.value })} /><button type="button" disabled={disabled || !localUrlValid} onClick={() => void run('models', async () => {
        setModels([]); setModelsNote('')
        try {
          const result = await localApi<{ models: LocalModel[] }>('/settings/local/models', { engine: draft.local.engine, baseUrl: draft.local.baseUrl.trim() })
          setModels(result.models)
          setModelsNote(result.models.length ? `读取到 ${result.models.length} 个模型，可在输入框中选择` : '没有读到模型，请先在本地服务中下载并加载；也可填写已加载的名称')
        } catch (reason) {
          setModelsNote('未能读取列表，确认服务已启动后重试；也可手写模型名称')
          throw reason
        }
      }, '')}>{pending === 'models' ? '读取中…' : '读取模型'}</button></div>
      <datalist id="xixi-local-models">{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
      {modelsNote && <small className="xixi-model-list-note" role="status">{modelsNote}</small>}
      <p className="xixi-settings-note">先安装本地服务并加载模型，再保存连接并测试工具兼容性。模型能力与速度取决于设备和模型，本机尚未测速。</p>
    </> : <>
      <div className="xixi-model-cloud-row"><label htmlFor="xixi-cloud-model">默认模型</label><select id="xixi-cloud-model" aria-label="默认模型" value={draft.cloudModel} disabled={disabled} onChange={event => change({ ...draft, cloudModel: event.target.value })}><option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></select></div>
      <form onSubmit={event => { event.preventDefault(); void run('key', async () => { await localApi('/settings/key', { key: key.trim() }); setKey(''); setTest(null) }, '已存入本机钥匙串') }} autoComplete="off">
        <label htmlFor="deepseek-local-key">{cloudConfigured ? '替换 API Key' : 'API Key'}</label>
        <div className="xixi-model-input-action"><input id="deepseek-local-key" name="astaria-connection-secret" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="保存到本机钥匙串，不回显" disabled={disabled} /><button type="submit" disabled={disabled || !key.trim()}>保存密钥</button></div>
      </form>
      <p className="xixi-settings-note">密钥只存本机钥匙串。发送时，相关对话、允许使用的记忆与事项会交给 DeepSeek；测试会产生少量 API 用量。</p>
    </>}
    <div className="xixi-settings-actions xixi-model-actions">
      <button type="button" disabled={disabled || !dirty || !valid} onClick={() => void save()}>{pending === 'save' ? '保存中…' : '保存连接设置'}</button>
      <button type="button" disabled={disabled || dirty || !status?.configured} onClick={() => void testConnection()}>{pending === 'test' ? '测试中…' : local ? '测试连接与工具' : '测试连接'}</button>
      {!local && cloudConfigured && <button type="button" disabled={disabled} onClick={() => void run('key', async () => { await localApi('/settings/key/remove', {}); setTest(null) }, '已从钥匙串移除密钥')}>移除密钥</button>}
      {dirty && <small>保存后即可测试</small>}
    </div>
    {test && <div className="xixi-model-test" role={test.ok && test.toolCalling !== false ? 'status' : 'alert'} data-result={test.ok && test.toolCalling !== false ? 'pass' : 'warning'}><strong>{!test.ok ? '连接测试未通过' : test.toolCalling === null ? '连接成功 · API 可用' : test.toolCalling ? '连接成功 · 工具调用可用' : '已连接 · 工具调用未通过'}</strong><span>{test.message}</span>{test.ok && test.toolCalling === false && <small>请换用支持工具调用的模型并重新测试，任务操作可能无法完成。</small>}</div>}
    {local && <aside className="xixi-model-device" aria-label="本机模型建议">
      <div className="xixi-model-device-summary"><strong>本机建议</strong><span>{device ? `${device.memoryGB} GB 内存${recommendation ? ` · 建议 ${recommendation.size}` : ''}` : deviceError ? '读取暂未完成' : '正在读取设备…'}</span></div>
      {device ? <details><summary>查看配置与模型规模建议</summary><small>{device.cpu} · {device.logicalCores} 核 · {device.platform} / {device.arch}<br />{device.acceleration}</small><ul>{device.recommendations.map(item => <li key={`${item.fit}:${item.size}`} data-fit={item.fit}><strong>{item.size} · {item.label}</strong><span>{item.reason}</span></li>)}</ul><p className="xixi-settings-note">{device.note} 这里只提供规模建议，不会自动下载模型；实际能力需要连接后测试。</p></details> : deviceError && <p role="status">{deviceError}<button type="button" disabled={disabled} onClick={() => setDeviceRequest(value => value + 1)}>重试读取</button></p>}
    </aside>}
  </section>
}
