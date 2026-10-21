/** A notification after an actual scene presentation, never a second RAF loop. */
const observers = new Set<() => void>()

export function observeSceneFrames(observer: () => void) {
  observers.add(observer)
  return () => { observers.delete(observer) }
}

export function publishSceneFrame() {
  for (const observer of observers) observer()
}
