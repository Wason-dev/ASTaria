import { useCallback, useEffect, useRef, useState } from 'react'
import { LocalApiError, localApi } from './api'
import './AppUpdates.css'

type UpdateState = {
  supported: boolean
  unsupportedReason?: string | null
  current: { version: string; builtAt: string | null; commit: string | null }
  automatic: boolean
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'unavailable' | 'error'
  error: string | null
  lastCheckedAt: string | null
  nextCheckAt: string | null
  latest: {
    version: string; tag: string; notes: string; publishedAt: string | null
    releaseUrl: string; downloadUrl: string | null; assetName: string | null; size: number | null
    builtAt?: string | null; sameVersion?: boolean
  } | null
  download: { version: string; sizeBytes: number; downloadedBytes: number } | null
  canInstall: boolean
  releasesUrl: string
  lastInstall?: { status: 'installed' | 'failed' | 'prepared'; message: string } | null
}
type UpdateAction = 'load' | 'poll' | 'check' | 'automatic' | 'download' | 'install' | 'cancel'
const POLL_LIMIT = 60

function localTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return ''
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
}

export function AppUpdates({ visible = true }: { visible?: boolean }) {
  const [state, setState] = useState<UpdateState | null>(null)
  const [pending, setPending] = useState<UpdateAction | null>('load')
  const [issue, setIssue] = useState('')
  const [unsupported, setUnsupported] = useState(false)
  const active = useRef(false)
  const sequence = useRef(0)
  const locked = useRef(false)
  const pollCount = useRef(0)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const request = useCallback(async function run(action: UpdateAction, enabled?: boolean): Promise<void> {
    if (!active.current || document.hidden || locked.current) return
    const id = ++sequence.current
    const current = () => active.current && !document.hidden && id === sequence.current
    locked.current = true
    clearTimeout(pollTimer.current)
    if (action !== 'poll') pollCount.current = 0
    setPending(action)
    setIssue('')
    let next: UpdateState | null = null
    try {
      next = await localApi<UpdateState>(
        action === 'automatic' ? '/desktop/updates/automatic' : action === 'check' ? '/desktop/updates/check'
          : action === 'download' ? '/desktop/updates/download' : action === 'install' ? '/desktop/updates/install'
            : action === 'cancel' ? '/desktop/updates/cancel' : '/desktop/updates',
        ['automatic', 'check'].includes(action) ? (action === 'automatic' ? { enabled } : {}) : ['download', 'install', 'cancel'].includes(action) ? {} : undefined,
      )
      if (!current()) return
      setState(next)
      setUnsupported(!next.supported)
      // Opening settings and enabling checks use the backend's normal schedule.
      if ((action === 'load' || (action === 'automatic' && enabled)) && next.supported && next.automatic) {
        next = await localApi<UpdateState>('/desktop/updates/check', { automatic: true })
        if (!current()) return
        setState(next)
        setUnsupported(!next.supported)
      }
      if (next.status === 'checking' && ++pollCount.current >= POLL_LIMIT) {
        setIssue('更新检查耗时较长，可点击「重新读取」查看结果。')
      }
    } catch (reason) {
      if (!current()) return
      next = null
      const previewWithoutService = import.meta.env.MODE !== 'desktop' && reason instanceof Error
        && reason.message === '请重新启动 ASTaria 本机服务后再试'
      if ((reason instanceof LocalApiError && reason.status === 404) || previewWithoutService) {
        setUnsupported(true)
      } else {
        setIssue(reason instanceof Error ? `${reason.message}，可稍后重试。` : '更新检查暂时未完成，可稍后重试。')
      }
    } finally {
      if (current()) {
        locked.current = false
        setPending(null)
        if (next?.supported && ((next.status === 'checking' && pollCount.current < POLL_LIMIT) || ['downloading', 'installing'].includes(next.status))) {
          pollTimer.current = setTimeout(() => { void run('poll') }, 1000)
        }
      }
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    active.current = true
    const suspend = () => {
      clearTimeout(pollTimer.current)
      sequence.current += 1
      locked.current = false
    }
    const onVisibility = () => {
      if (document.hidden) { suspend(); setPending(null) }
      else void request('load')
    }
    void request('load')
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active.current = false
      suspend()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [request, visible])

  const checking = !issue && state?.status === 'checking'
  const transferring = state?.status === 'downloading' || state?.status === 'installing'
  const busy = (pending !== null && pending !== 'poll') || checking || transferring
  const unavailable = unsupported || state?.supported === false
  const latest = !unavailable && ['available', 'downloading', 'ready', 'installing', 'error'].includes(state?.status ?? '') ? state?.latest ?? null : null
  const checkedAt = localTime(state?.lastCheckedAt)
  const builtAt = localTime(state?.current.builtAt)
  const releaseDate = localTime(latest?.publishedAt)
  const downloadBytes = state?.download?.downloadedBytes ?? 0
  const downloadSizeBytes = state?.download?.sizeBytes ?? 0
  const downloadPercent = downloadSizeBytes > 0
    ? Math.min(100, Math.max(0, (downloadBytes / downloadSizeBytes) * 100))
    : 0
  const statusText = unavailable ? state?.unsupportedReason ?? '请在 ASTaria 桌面 App 内检测更新，浏览器预览不支持。'
    : issue || (pending === 'automatic' ? '正在保存自动检查设置…'
      : pending === 'download' || state?.status === 'downloading' ? '正在下载并校验安装包…'
        : pending === 'install' || state?.status === 'installing' ? '正在验证并准备安装，完成后自动重启…'
      : pending === 'check' || checking ? '正在检查 GitHub 更新…'
        : pending === 'load' ? '正在读取更新状态…'
          : state?.status === 'available' && latest ? latest.sameVersion ? `发现 ${latest.version} 的新构建` : `发现新版本 ${latest.version}`
            : state?.status === 'ready' ? state.error || '安装包已下载并通过校验，可以安装并重启'
            : state?.status === 'up-to-date' ? '当前已是最新可用版本'
              : state?.status === 'error' || state?.status === 'unavailable' ? state.error || '暂时无法确认可用更新，请稍后重试。'
                : state?.automatic ? '自动检查已开启，也可以手动检查更新。' : '自动检查已关闭，可随时手动检查更新。')

  return <section className="xixi-app-updates" aria-labelledby="xixi-app-updates-title">
    <h3 id="xixi-app-updates-title">App 更新</h3>
    <div className="xixi-setting-row">
      <div><strong>当前版本</strong>{builtAt && <small>构建于 {builtAt}</small>}</div>
      <div className="xixi-app-version"><output>{state?.current.version ?? '—'}</output></div>
    </div>
    <div className="xixi-setting-row">
      <div><strong>自动检查更新</strong><small>App 运行时定期检查 GitHub 发布</small></div>
      <div><button className="xixi-toggle" type="button" role="switch" aria-label="自动检查更新" aria-checked={state?.automatic ?? false} disabled={busy || unavailable || !state} onClick={() => void request('automatic', !state?.automatic)}><span /></button></div>
    </div>
    <div className="xixi-app-update-feedback" role="status" aria-live="polite" aria-atomic="true" data-error={Boolean(issue || state?.status === 'error')}>
      <p>{statusText}</p>
      {!unavailable && checkedAt && <small>上次检查 {checkedAt}</small>}
    </div>
    {state?.lastInstall && <div className="xixi-app-update-feedback xixi-app-update-last-install" data-error={state.lastInstall.status === 'failed'} role="status"><p>{state.lastInstall.message}</p></div>}
    {!unavailable && <div className="xixi-settings-actions xixi-app-update-actions">
      <button type="button" disabled={busy || state?.status === 'ready'} onClick={() => void request(!state || state.status === 'checking' ? 'load' : 'check')}>{checking || pending === 'check' ? '检查中…' : !state || state.status === 'checking' ? '重新读取' : '检查更新'}</button>
      {latest?.downloadUrl && (state?.status === 'available' || state?.status === 'error') && <button type="button" className="xixi-app-update-download" disabled={busy} onClick={() => void request('download')}>下载并校验{latest.size ? ` · ${(latest.size / 1024 / 1024).toFixed(1)} MB` : ''}</button>}
      {state?.status === 'downloading' && <button type="button" className="xixi-app-update-download" disabled={pending === 'cancel'} onClick={() => void request('cancel')}>取消下载</button>}
      {state?.status === 'ready' && state.canInstall && <button type="button" className="xixi-app-update-download" disabled={busy} onClick={() => void request('install')}>安装并重启</button>}
      {latest?.downloadUrl && <a href={latest.downloadUrl} target="_blank" rel="noopener noreferrer">手动下载</a>}
      {state?.releasesUrl && <a href={latest?.releaseUrl || state.releasesUrl} target="_blank" rel="noopener noreferrer">GitHub 发布页</a>}
    </div>}
    {state?.download && state.status === 'downloading' && <div className="xixi-update-progress">
      <progress className="xixi-update-progress-native" aria-label="更新下载进度" max={state.download.sizeBytes} value={state.download.downloadedBytes} />
      <div className="xixi-update-progress-track" aria-hidden="true"><span style={{ width: `${downloadPercent}%` }} /></div>
      <small>{(state.download.downloadedBytes / 1024 / 1024).toFixed(1)} / {(state.download.sizeBytes / 1024 / 1024).toFixed(1)} MB</small>
    </div>}
    {latest && <>
      {latest.notes && <details className="xixi-app-update-notes"><summary>更新说明{releaseDate && <small>{releaseDate}</small>}</summary><p>{latest.notes}</p></details>}
      {latest.downloadUrl && <p className="xixi-settings-note xixi-app-update-install">安装包会先校验 SHA-256；安装时退出并重启 App，本机事项、日程和对话数据会保留。自动安装需要 App 位于当前账户可替换的位置，通常是「应用程序」文件夹；若从 DMG 直接运行，请先拖入该文件夹。</p>}
    </>}
  </section>
}
