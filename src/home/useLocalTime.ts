import { useEffect, useState } from 'react'

/** One local clock keeps the header and daily agenda in sync across midnight. */
export function useLocalTime() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const date = new Date()
      setNow(date)
      timer = setTimeout(refresh, 60_000 - date.getTime() % 60_000)
    }
    const resume = () => { if (document.visibilityState === 'visible') refresh() }
    refresh()
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return now
}
