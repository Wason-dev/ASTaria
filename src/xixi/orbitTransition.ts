export type OrbitTransitionFrame = {
  flight: number
  reveal: number
  darkness: number
  /** Activate the covered workspace now; the caller fires onReveal only once. */
  revealDestination: boolean
}

const unit = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
const smooth = (start: number, end: number, value: number) => {
  const t = unit((value - start) / (end - start))
  return t * t * (3 - 2 * t)
}
const smoother = (value: number) => {
  const t = unit(value)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/** Milliseconds. The adjustable normal exit is independent of reduced motion. */
export function orbitTransitionDuration(exit: boolean, reduced: boolean, exitSeconds = 2.4): number {
  if (reduced) return 180
  if (!exit) return 5600
  const seconds = Number.isFinite(exitSeconds) && exitSeconds > 0 ? exitSeconds : 2.4
  return Math.min(10, Math.max(.2, seconds)) * 1000
}

/** A camera pullback and two separate fades, all continuous at an interrupted entry. */
export function orbitTransitionFrame(
  progress: number, fromFlight: number, exit: boolean, reduced = false,
): OrbitTransitionFrame {
  const p = unit(progress), from = unit(fromFlight), eased = smoother(p)
  if (!exit) {
    const flight = from + (1 - from) * eased
    return { flight, reveal: smooth(.62, 1, flight), darkness: smooth(.46, .78, flight), revealDestination: false }
  }

  // Match the entry's current appearance exactly, including a cancellation made
  // before either the orbit canvas or its black veil has finished appearing.
  const initialReveal = smooth(.62, 1, from)
  const initialDarkness = smooth(.46, .78, from)
  const reveal = initialReveal * (1 - (reduced ? eased : smooth(.10, .58, p)))
  const darkness = initialDarkness * (1 - (reduced ? eased : smoother((p - .32) / .64)))
  return {
    flight: from * (1 - eased), reveal, darkness,
    // FreeTimePanel starts a 480ms arrival when uncovered. At the normal 2.4s
    // duration, activation at .12 lets it finish while the veil is still opaque
    // through .32. If entry was cancelled before full cover, restore immediately.
    revealDestination: reduced || initialDarkness < .95 || p >= .12,
  }
}
