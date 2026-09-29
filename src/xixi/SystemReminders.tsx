import { useEffect, useState } from 'react'
import { localApi, LocalApiError } from './api'

type State = { enabled: boolean; authorization: number; count: number; through: number | null; omitted: number; error: string | null }
export function SystemReminders() {
  const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false), [issue, setIssue] = useState(''), [supported, setSupported] = useState(true)
  useEffect(() => {
    let live = true
    localApi<State>('/desktop/reminders').then(value => { if (live) setState(value) }).catch(reason => {
      if (!live) return
      if (reason instanceof LocalApiError && reason.status === 404 || import.meta.env.MODE !== 'desktop') setSupported(false)
      else setIssue('系统提醒暂未读取，请稍后重试')
    })
    return () => { live = false }
  }, [])
  const update = async (enabled?: boolean) => {
    if (busy) return
    setBusy(true); setIssue('')
    try { setState(await localApi<State>(enabled === undefined ? '/desktop/reminders/refresh' : '/desktop/reminders/enabled', enabled === undefined ? {} : { enabled })) }
    catch (reason) { setIssue(reason instanceof Error ? reason.message : '系统提醒尚未更新') }
    finally { setBusy(false) }
  }
  return <section className="xixi-notification-preferences"><h3>系统提醒</h3>
    <div className="xixi-setting-row"><div><strong>关闭 App 后仍提醒</strong><small>由 macOS 保存预约，开启时申请通知权限</small></div><div><button className="xixi-toggle" type="button" role="switch" aria-label="关闭 App 后仍提醒" aria-checked={state?.enabled ?? false} disabled={busy || !supported || !state} onClick={() => void update(!state?.enabled)}><span /></button></div></div>
    <p>已安排事项、课程和活动提前 5 分钟提醒；明确的截止时刻提前 30 分钟，仅日期的截止在当天 20:00 提醒。遵循上方免打扰时段。</p>
    <p role="status">{!supported ? '系统提醒仅支持 macOS 桌面 App。' : busy ? '正在与 macOS 同步…' : issue || state?.error || (state?.enabled ? `已预约 ${state.count} 条提醒${state.through ? `，最近一批排至 ${new Date(state.through * 1000).toLocaleString('zh-CN', { hour12: false })}` : ''}。` : '尚未开启系统提醒。')}</p>
    {state?.enabled && <p>最多预约未来 30 天内最近的 64 条；每次打开 App、恢复使用或修改日程后补充。{state.omitted > 0 ? `另有 ${state.omitted} 条将在后续补充。` : ''}系统专注模式、关机或通知权限会影响实际送达。</p>}
    {supported && <div className="xixi-settings-actions"><button type="button" disabled={busy} onClick={() => void update()}>重新同步提醒</button></div>}
  </section>
}
