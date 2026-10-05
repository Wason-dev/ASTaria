import { useEffect, useState } from 'react'
import { localApi } from './api'
import { notifyLocalDataChange } from '../stores/migration'

type SyncStatus = {
  available: boolean; configured: boolean; directory?: string; mode?: 'shared' | 'syncthing'; paused?: boolean
  deviceId?: string; pendingExports?: number; message: string; lastCheckedAt?: string | null
  conflicts: { operationId: string; deviceId: string; sequence: number; reason: string }[]
  receipts?: { operationId: string; deviceId: string; receivedAt: string; outcome: string; summary: string }[]
}

export function FolderSyncSettings() {
  const [state, setState] = useState<SyncStatus | null>(null)
  const [mode, setMode] = useState<'shared' | 'syncthing'>('shared')
  const [joining, setJoining] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  useEffect(() => {
    let active = true
    const refresh = () => {
      if (document.hidden) return
      void localApi<SyncStatus>('/sync/status').then(value => { if (active) setState(value) }).catch(reason => { if (active) setError(reason.message) })
    }
    refresh()
    const timer = window.setInterval(refresh, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  async function action(path: string, input: object) {
    setBusy(true); setError('')
    try {
      const value = await localApi<SyncStatus>(`/sync/${path}`, input)
      setState(value); setKey(''); setDisconnecting(false); notifyLocalDataChange()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '同步操作未完成') }
    finally { setBusy(false) }
  }
  return <section className="xixi-folder-sync" aria-label="跨设备同步">
    <h3>跨设备同步</h3>
    <p role="status" aria-live="polite">{busy ? '正在处理，请稍候' : state?.message ?? '正在读取同步状态'}</p>
    {error && <p role="alert">{error}</p>}
    {state?.available && !state.configured && <>
      <label>传输方式<select aria-label="同步传输方式" value={mode} disabled={busy} onChange={event => setMode(event.target.value as typeof mode)}><option value="shared">共享文件夹</option><option value="syncthing">Syncthing 目录</option></select></label>
      <p>{mode === 'syncthing' ? '先在 Syncthing 中共享文件夹，再选择这台电脑对应的目录。' : '选择云盘的本地文件夹、共享磁盘或 NAS 目录。'}每台设备保留本机数据，目录只搬运加密操作。</p>
      <label>连接方式<select aria-label="同步连接方式" value={joining ? 'join' : 'create'} disabled={busy} onChange={event => { setJoining(event.target.value === 'join'); setKey('') }}><option value="create">建立新同步组</option><option value="join">加入已有同步组</option></select></label>
      {joining && <label>同步密钥<input type="password" autoComplete="off" spellCheck={false} aria-label="同步密钥" value={key} maxLength={64} disabled={busy} onChange={event => setKey(event.target.value.trim())} /></label>}
      <div className="xixi-settings-actions"><button type="button" disabled={busy || joining && !/^[a-f0-9]{64}$/.test(key)} onClick={() => void action('configure', { mode, create: !joining, ...(joining ? { joinKey: key } : {}) })}>选择目录并{joining ? '加入' : '建立'}</button></div>
    </>}
    {state?.configured && <>
      <div className="xixi-setting-row"><div><strong>{state.mode === 'syncthing' ? 'Syncthing 目录' : '共享文件夹'}</strong><p>{state.directory}</p></div></div>
      <p>待导出 {state.pendingExports ?? 0} 条 · {state.lastCheckedAt ? `最近检查 ${new Date(state.lastCheckedAt).toLocaleString('zh-CN')}` : '尚未完成目录检查'}</p>
      <div className="xixi-settings-actions">
        <button type="button" disabled={busy} onClick={() => void action('check', {})}>检查目录</button>
        <button type="button" disabled={busy} onClick={() => void action('pause', { paused: !state.paused })}>{state.paused ? '继续同步' : '暂停同步'}</button>
        <button type="button" disabled={busy} onClick={() => void action('export-key', {})}>导出恢复密钥</button>
        <button type="button" disabled={busy} onClick={() => setDisconnecting(true)}>断开此设备</button>
      </div>
      {disconnecting && <div className="xixi-import-confirm"><p>断开会保留本机数据和共享文件。其他设备仍可使用原密钥；若要撤销旧设备，请用新目录建立新组，并只向受信任设备提供新密钥。</p><div className="xixi-settings-actions"><button type="button" disabled={busy} onClick={() => void action('disconnect', { confirmed: true })}>确认断开</button><button type="button" disabled={busy} onClick={() => setDisconnecting(false)}>取消</button></div></div>}
      {state.conflicts.length > 0 && <div><h3>待处理操作</h3><ul className="xixi-memory-list">{state.conflicts.map(item => <li key={item.operationId}><div><p>{item.reason}</p><small>设备 {item.deviceId.slice(0, 8)} · 第 {item.sequence} 条</small>{!item.reason.startsWith('等待') && <div className="xixi-settings-actions"><button type="button" disabled={busy} onClick={() => void action('resolve', { operationId: item.operationId, choice: 'local' })}>保留本机这次修改</button><button type="button" disabled={busy} onClick={() => void action('resolve', { operationId: item.operationId, choice: 'remote' })}>重新核验并采用传入修改</button></div>}</div></li>)}</ul></div>}
      {Boolean(state.receipts?.length) && <details><summary>最近变更回执</summary><ul className="xixi-memory-list">{state.receipts?.map(item => <li key={item.operationId}><div><p>{item.outcome === 'local' ? '本机已保存' : item.outcome === 'kept-local' ? '已保留本机修改' : '已接收并保存'} · {item.summary}</p><small>{new Date(item.receivedAt).toLocaleString('zh-CN')} · 设备 {item.deviceId.slice(0, 8)}</small></div></li>)}</ul><p>回执记录本机保存结果；其他设备是否收到取决于文件传输。原始对话回执和跨设备撤销不随同步传递。</p></details>}
    </>}
    <p>同步密钥请保存在共享目录之外。API Key、聊天、记忆和思考过程不进入同步；密钥丢失且没有备份时，旧操作文件无法恢复。</p>
  </section>
}
