import { useEffect, useRef, useState } from 'react'
import { localApi, LocalApiError } from './api'

type State = { supported?: boolean; platform?: 'macos' | 'ios' | 'android' | 'web-preview'; enabled: boolean; authorization: number; count: number; through: number | null; omitted: number; error: string | null; previewMode?: 'always' | 'when-unlocked' | 'never' | 'unknown'; iconAvailable?: boolean | null; registeredBundleMatches?: boolean | null; registeredIconAvailable?: boolean | null }
export function SystemReminders() {
  const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [available, setAvailable] = useState(true)
  const running = useRef(false), live = useRef(false), revision = useRef(0)
  useEffect(() => {
    live.current = true
    const version = ++revision.current, controller = new AbortController()
    localApi<State>('/desktop/reminders', undefined, { signal: controller.signal }).then(value => {
      if (live.current && version === revision.current) setState(value)
    }).catch(reason => {
      if (!live.current || version !== revision.current || controller.signal.aborted) return
      if (reason instanceof LocalApiError && reason.status === 404) setAvailable(false)
      else setIssue(reason instanceof Error ? reason.message : '系统提醒暂未读取，请稍后重试')
    })
    return () => { live.current = false; controller.abort() }
  }, [])
  const supported = available && state?.supported !== false
  const platform = state?.platform ?? (document.documentElement.dataset.mobile || import.meta.env.MODE === 'mobile' ? 'web-preview' : 'macos')
  const mobile = platform === 'ios' || platform === 'android'
  const system = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : platform === 'macos' ? 'macOS' : '系统'
  const label = mobile ? 'App 外系统提醒' : '关闭 App 后仍提醒'
  const update = async (enabled?: boolean) => {
    if (running.current || !supported) return
    running.current = true; ++revision.current; setBusy(true); setIssue('')
    try {
      const next = await localApi<State>(enabled === undefined ? '/desktop/reminders/refresh' : '/desktop/reminders/enabled', enabled === undefined ? {} : { enabled }, { timeoutMs: enabled ? 120_000 : 30_000 })
      if (live.current) setState(next)
    } catch (reason) { if (live.current) setIssue(reason instanceof Error ? reason.message : '系统提醒尚未更新') }
    finally { running.current = false; if (live.current) setBusy(false) }
  }
  const testReminder = async () => {
    if (running.current || !supported || !state?.enabled || ![2, 3].includes(state.authorization)) return
    running.current = true; setBusy(true); setIssue('')
    try { const result = await localApi<{ message: string }>('/desktop/reminders/test', {}); if (live.current) setIssue(result.message) }
    catch (reason) { if (live.current) setIssue(reason instanceof Error ? reason.message : '测试提醒未能发送，请稍后重试') }
    finally { running.current = false; if (live.current) setBusy(false) }
  }
  return <section className="xixi-notification-preferences"><h3>系统提醒</h3>
    <div className="xixi-setting-row"><div><strong>{label}</strong><small>{supported ? `由 ${system} 保存预约，仅在开启时申请通知权限` : platform === 'web-preview' ? '浏览器预览不保存系统预约' : '当前环境尚未提供系统提醒'}</small></div><div><button className="xixi-toggle" type="button" role="switch" aria-label={label} aria-checked={state?.enabled ?? false} disabled={busy || !supported || !state} onClick={() => void update(!state?.enabled)}><span /></button></div></div>
    <p>已安排事项、课程和活动提前 5 分钟提醒；明确的截止时刻提前 30 分钟，仅日期的截止在当天 20:00 提醒。遵循上方免打扰时段。</p>
    <p role="status">{!supported ? state?.error || '系统预约提醒支持 macOS 桌面 App、iOS 和 Android App；浏览器预览不支持。' : busy ? `正在与 ${system} 同步…` : issue || state?.error || (!state ? '正在读取系统提醒…' : state.enabled ? `已预约 ${state.count} 条提醒${state.through ? `，最近一批排至 ${new Date(state.through * 1000).toLocaleString('zh-CN', { hour12: false })}` : ''}。` : '尚未开启系统提醒。')}</p>
    {mobile && <p>{platform === 'android' ? '已预约提醒可由 Android 在后台提示；省电限制可能延迟送达，强制停止 App 后无法保证送达。本功能使用普通预约，不申请精确闹钟权限，不能保证精确时刻。' : '已预约提醒由 iOS 保存，退出 App 后仍可提示；关闭 App 时不会继续生成新预约。'}系统专注模式、关机与通知权限也会影响实际送达。</p>}
    {state?.enabled && <p>最多预约未来 30 天内最近的 64 条；每次打开 App、恢复使用或修改日程后补充。{!state.error && state.omitted > 0 ? `另有 ${state.omitted} 条将在后续补充。` : ''}{!mobile && '系统专注模式、关机或通知权限会影响实际送达。'}</p>}
    {platform === 'macos' && state?.enabled && state.previewMode === 'never' && <p>macOS 已关闭通知预览，所以提醒会隐藏正文。若希望显示内容，可在「系统设置 → 通知 → ASTaria」调整显示预览。</p>}
    {platform === 'macos' && state?.enabled && state.previewMode === 'when-unlocked' && <p>通知正文会在解锁后显示，锁屏时隐藏。</p>}
    {platform === 'macos' && state?.enabled && state.registeredBundleMatches === false && <p>macOS 仍关联着旧版提醒组件，通知图标可能缺失。请从已安装的当前版本打开 ASTaria，再重新同步提醒。</p>}
    {platform === 'macos' && state?.enabled && state.registeredBundleMatches !== false && (state.iconAvailable === false || state.registeredIconAvailable === false) && <p>系统提醒图标未能读取，可重新安装当前版本后再同步提醒。</p>}
    {supported && <div className="xixi-settings-actions"><button type="button" disabled={busy} onClick={() => void update()}>重新同步提醒</button><button type="button" disabled={busy || !state?.enabled || ![2, 3].includes(state.authorization)} onClick={() => void testReminder()}>发送测试提醒</button></div>}
  </section>
}
