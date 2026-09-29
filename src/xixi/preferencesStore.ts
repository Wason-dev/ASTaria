import { sameSnapshot } from '../stores/sameSnapshot.ts'

type Snapshot<T> = { value: T; loaded: boolean; error: string }
type Listener = () => void
type StoreOptions<T> = {
  initialValue: T
  read: () => Promise<T>
  isVisible: () => boolean
  onVisibilityChange: (listener: Listener) => Listener
  onPublish: (listener: (value: T) => void) => Listener
  setTimer: (listener: Listener, delay: number) => number
  clearTimer: (timer: number) => void
}

export function createPreferencesStore<T>(options: StoreOptions<T>) {
  let snapshot: Snapshot<T> = { value: options.initialValue, loaded: false, error: '' }
  const listeners = new Set<Listener>()
  let revision = 0
  let inFlight: { revision: number; promise: Promise<void> } | null = null
  let timer: number | undefined
  let stopListening: Listener | undefined

  function update(next: Snapshot<T>) {
    const value = sameSnapshot(snapshot.value, next.value) ? snapshot.value : next.value
    if (value === snapshot.value && next.loaded === snapshot.loaded && next.error === snapshot.error) return
    snapshot = { ...next, value }
    listeners.forEach(listener => listener())
  }

  function clearPoll() {
    if (timer !== undefined) options.clearTimer(timer)
    timer = undefined
  }

  function schedulePoll() {
    clearPoll()
    if (!listeners.size || !options.isVisible() || inFlight) return
    timer = options.setTimer(() => { timer = undefined; void refresh() }, 15_000)
  }

  function refresh(): Promise<void> {
    if (inFlight) {
      // A save supersedes an older read. An explicit refresh after that save waits
      // for a fresh read, without overlapping requests or accepting the stale one.
      return inFlight.revision === revision ? inFlight.promise : inFlight.promise.then(refresh)
    }
    clearPoll()
    const current = revision
    const promise = Promise.resolve().then(options.read).then(value => {
      if (current === revision) update({ value, loaded: true, error: '' })
    }).catch(reason => {
      if (current === revision) update({ ...snapshot, error: reason instanceof Error ? reason.message : '暂时无法读取设置' })
    }).finally(() => {
      inFlight = null
      schedulePoll()
    })
    inFlight = { revision: current, promise }
    return promise
  }

  function publish(value: T) {
    revision++
    update({ value, loaded: true, error: '' })
    schedulePoll()
  }

  function visibilityChanged() {
    clearPoll()
    if (options.isVisible()) void refresh()
  }

  function subscribe(listener: Listener) {
    listeners.add(listener)
    if (listeners.size === 1) {
      const stopVisibility = options.onVisibilityChange(visibilityChanged)
      const stopPublish = options.onPublish(publish)
      stopListening = () => { stopVisibility(); stopPublish() }
      if (options.isVisible()) void refresh()
    }
    return () => {
      listeners.delete(listener)
      if (listeners.size) return
      clearPoll()
      stopListening?.()
      stopListening = undefined
      // Keep the single pending read for an immediate StrictMode remount. It may
      // update the cache, but cannot restart polling without an active subscriber.
    }
  }

  return { getSnapshot: () => snapshot, subscribe, refresh, publish }
}
