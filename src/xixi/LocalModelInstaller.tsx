import { useEffect, useState } from 'react'
import { LocalApiError, localApi } from './api'

type InstallOption = { id: string; label: string; downloadGB: number; diskGB: number; minMemoryGB: number; installed: boolean; recommended: boolean }
type InstallJob = { id: string; baseUrl: string; model: string; status: 'checking' | 'downloading' | 'succeeded' | 'failed' | 'cancelled'; message: string; completedBytes: number; totalBytes: number | null; percent: number | null; createdAt: string; updatedAt: string; error: string | null }
type InstallOptions = { baseUrl: string; runtimeAvailable: boolean; runtimeVersion: string | null; message: string; options: InstallOption[]; activeJob: InstallJob | null; latestJob: InstallJob | null }
type Props = { baseUrl: string; disabled: boolean; onChoose: (model: string) => void }
const running = (job: InstallJob | null) => job?.status === 'checking' || job?.status === 'downloading'
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '暂时无法连接，请重试'
const bytes = (value: number) => value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.round(value / 1e6)} MB`

export function LocalModelInstaller({ baseUrl, disabled, onChoose }: Props) {
  const [options, setOptions] = useState<InstallOptions | null>(null)
  const [job, setJob] = useState<InstallJob | null>(null)
  const [selected, setSelected] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let current = true
    setBusy(true); setOptions(null); setJob(null); setError(''); setConfirming(false)
    void localApi<InstallOptions>(`/settings/local/install-options?baseUrl=${encodeURIComponent(baseUrl)}`).then(value => {
      if (!current) return
      setOptions(value); setJob(value.activeJob ?? value.latestJob)
      setSelected(value.options.find(option => option.recommended)?.id ?? '')
    }).catch(reason => { if (current) setError(errorText(reason)) }).finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [baseUrl, reload])
  const active = running(job)
  useEffect(() => {
    if (!job || !active) return
    let current = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await localApi<InstallJob>(`/settings/local/install/${encodeURIComponent(job.id)}`)
        if (!current) return
        // A response started before cancellation must not revive the old job.
        setJob(previous => previous?.id === next.id && !running(previous) && running(next) ? previous : next); setError('')
        if (running(next)) timer = setTimeout(poll, 1200)
        else if (next.status === 'succeeded') setOptions(previous => previous && ({ ...previous, options: previous.options.map(option => option.id === next.model ? { ...option, installed: true } : option) }))
      } catch (reason) {
        if (!current) return
        setError(errorText(reason))
        if (reason instanceof LocalApiError && reason.status === 404) { setJob(null); return }
        // Keep cancellation/recovery available after a transient polling loss.
        timer = setTimeout(poll, 4000)
      }
    }
    timer = setTimeout(poll, 500)
    return () => { current = false; clearTimeout(timer) }
  }, [job?.id, active])
  const option = options?.options.find(item => item.id === selected)
  const start = async () => {
    if (!option || !confirming) return
    setBusy(true); setError('')
    try {
      setJob(await localApi<InstallJob>('/settings/local/install', { baseUrl, model: option.id, confirmed: true }))
      setConfirming(false)
    } catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  const cancel = async () => {
    if (!job) return
    setBusy(true)
    try { setJob(await localApi<InstallJob>(`/settings/local/install/${encodeURIComponent(job.id)}/cancel`, {})); setError('') }
    catch (reason) { setError(errorText(reason)) }
    finally { setBusy(false) }
  }
  return <div className="xixi-model-installer" aria-label="安装本地模型">
    <div className="xixi-installer-heading"><strong>安装本地模型</strong><button type="button" disabled={busy || disabled} onClick={() => setReload(value => value + 1)}>重新检测</button></div>
    {!options && !error && <p role="status">正在检测 Ollama…</p>}
    {options && !options.runtimeAvailable && <div className="xixi-installer-runtime"><p>{options.message}</p><a href="https://ollama.com/download" target="_blank" rel="noreferrer">下载 Ollama</a><small>安装并打开后点「重新检测」，接下来由 ASTaria 帮你下载模型。</small></div>}
    {options?.runtimeAvailable && !active && <>
      <small>{options.message}</small>
      <div className="xixi-installer-choice"><label htmlFor="xixi-install-model">选择模型</label><select id="xixi-install-model" value={selected} disabled={disabled || busy || confirming} onChange={event => { setSelected(event.target.value); setConfirming(false) }}>{!selected && <option value="" disabled>请选择模型</option>}{options.options.map(item => <option key={item.id} value={item.id}>{item.label}{item.recommended ? ' · 本机推荐' : ''}{item.installed ? ' · 已安装' : ''}</option>)}</select></div>
      {option && <p className="xixi-installer-size">下载约 {option.downloadGB} GB · 建议预留 {option.diskGB} GB 磁盘 · 内存建议 ≥ {option.minMemoryGB} GB</p>}
      <small>默认选择适合本机内存的 Qwen3；建议在 Ollama 中设置 32K 上下文。</small>
      {!confirming && option && !(job?.status === 'succeeded' && job.model === option.id) && <button className="xixi-installer-primary" type="button" disabled={disabled || busy} onClick={() => option.installed ? onChoose(option.id) : setConfirming(true)}>{option.installed ? '使用这个模型' : '下载这个模型'}</button>}
      {confirming && option && <div className="xixi-installer-confirm" role="group" aria-label="确认模型下载"><p>下载 {option.label} 到这台电脑？约 {option.downloadGB} GB，将由 Ollama 从模型仓库下载，可随时取消。</p><div><button className="xixi-installer-primary" type="button" disabled={busy || disabled} onClick={() => void start()}>{busy ? '启动中…' : '确认下载'}</button><button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></div></div>}
    </>}
    {job && <div className="xixi-installer-progress" role="status" aria-live="polite" data-status={job.status}>
      <div><strong>{job.model}</strong><span>{job.status === 'succeeded' ? '已安装' : job.status === 'cancelled' ? '已取消' : job.status === 'failed' ? '下载未完成' : job.percent == null ? '准备下载' : `${Math.floor(job.percent)}%`}</span></div>
      {active && <progress aria-label="模型下载进度" max={100} value={job.percent ?? undefined} />}
      <small>{job.error || job.message}{active && job.totalBytes ? ` · ${bytes(job.completedBytes)} / ${bytes(job.totalBytes)}` : ''}</small>
      {active ? <><button type="button" disabled={busy} onClick={() => void cancel()}>取消下载</button><small>离开设置仍会继续；取消后已下载的部分可能由 Ollama 保留。</small></> : job.status === 'succeeded' && <button type="button" disabled={disabled || busy} onClick={() => onChoose(job.model)}>使用已安装的模型</button>}
    </div>}
    {error && <p className="xixi-installer-error" role="alert">{error}</p>}
  </div>
}
