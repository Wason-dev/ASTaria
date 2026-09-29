interface FocusTimerTickerOptions {
  remainingMs: () => number | null
  isVisible: () => boolean
  tick: (checkpoint: boolean) => void
  setTimeout: (callback: () => void, delay: number) => number
  clearTimeout: (id: number) => void
}

/** UI ticks only while visible; a hidden running timer wakes once at its deadline. */
export function createFocusTimerTicker(options: FocusTimerTickerOptions) {
  let timeout: number | undefined
  let stopped = false

  const clear = () => {
    if (timeout !== undefined) options.clearTimeout(timeout)
    timeout = undefined
  }
  const schedule = () => {
    if (stopped) return
    const remaining = options.remainingMs()
    if (remaining === null) return
    const delay = options.isVisible() ? Math.min(250, remaining) : remaining
    timeout = options.setTimeout(() => {
      timeout = undefined
      if (stopped) return
      options.tick(false)
      schedule()
    }, Math.max(1, delay))
  }

  return {
    refresh(checkpoint = false) {
      if (stopped) return
      clear()
      options.tick(checkpoint)
      schedule()
    },
    stop() {
      stopped = true
      clear()
    },
  }
}
