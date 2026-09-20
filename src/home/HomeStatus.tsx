import { MeasuredGlassSurface } from './GlassSurface'

const clockFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const shortDateFormat = new Intl.DateTimeFormat('en-US', { month: '2-digit', day: '2-digit' })

/** Receives display text once Xixi's notification policy is connected. */
type Props = { now: Date; showClock: boolean; notification?: string; onNotification?: () => void }

export function HomeStatus({ now, showClock, notification, onNotification }: Props) {
  const time = clockFormat.format(now)
  const date = dateFormat.format(now)
  const message = notification?.trim() || '暂无通知'
  return <>
    {showClock && <time className="home-clock" dateTime={now.toISOString()} aria-label={`当前日期时间 ${date} ${time}`} title={`${date} ${time}`}>
      <span className="home-clock-date" aria-hidden="true">{date}</span><span className="home-clock-short-date" aria-hidden="true">{shortDateFormat.format(now)}</span><span className="home-clock-time" aria-hidden="true">{time}</span>
    </time>}
    <div className="home-notification" role="status" aria-live="polite" aria-atomic="true" title={message}>
      <MeasuredGlassSurface radius={16} />
      <button type="button" className="home-notification-content" onClick={onNotification} aria-label={`${message}，查看详情`}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 12.5a1.5 1.5 0 0 0 3 0M3.5 10.5h9c-1-1.2-1-2.5-1-4a3.5 3.5 0 0 0-7 0c0 1.5 0 2.8-1 4Z" /></svg>
        <span className="home-notification-text">{message}</span>
      </button>
    </div>
  </>
}
