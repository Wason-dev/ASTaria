import { observePageActivity, pageIsVisible } from '../stores/pageActivity.ts'
import { useEffect, useState } from 'react'

/** One local clock keeps the header and daily agenda in sync across midnight. */
export function useLocalTime() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      if (!pageIsVisible()) return
      const date = new Date()
      setNow(date)
      timer = setTimeout(refresh, 60_000 - date.getTime() % 60_000)
    }
    const resume = () => { refresh() }
    refresh()
    const unobserve = observePageActivity(resume)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      unobserve()
      window.removeEventListener('focus', refresh)
    }
  }, [])
  return now
}
