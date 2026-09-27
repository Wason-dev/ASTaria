export type AdaptiveQuality = 'ultra' | 'high' | 'low' | 'safe'

const TIERS: readonly AdaptiveQuality[] = ['safe', 'low', 'high', 'ultra']
const RECOVERY_MS: Record<AdaptiveQuality, number> = { safe: 12_000, low: 18_000, high: 24_000, ultra: Infinity }

/** RAF-based quality decisions with hysteresis and bounded recovery probes. */
export class AdaptiveQualityController {
  private samples: number[] = []
  private sampleSum = 0
  private warmupRemaining = 2_000
  private slowDuration = 0
  private stableDuration = 0
  private activeTime = 0
  private failures: Partial<Record<AdaptiveQuality, number>> = {}
  private retryAfter: Partial<Record<AdaptiveQuality, number>> = {}

  /** Resizing, resuming and transitions invalidate timing, not failed-probe history. */
  resetWindow(warmup = 2_000): void {
    this.samples = []
    this.sampleSum = 0
    this.warmupRemaining = warmup
    this.slowDuration = 0
    this.stableDuration = 0
  }

  /** An explicit quality selection starts a fresh policy session. */
  reset(): void {
    this.resetWindow()
    this.activeTime = 0
    this.failures = {}
    this.retryAfter = {}
  }

  sample(elapsed: number, quality: AdaptiveQuality, transitioning = false): AdaptiveQuality | null {
    if (!Number.isFinite(elapsed) || elapsed <= 0) return null
    // A debugger pause or a single blocked main-thread frame must not count as
    // seconds of sustained load. Repeated slow frames still accumulate normally.
    const duration = Math.min(elapsed, 100)
    this.activeTime += duration
    if (transitioning) {
      this.resetWindow(1_500)
      return null
    }
    if (this.warmupRemaining > 0) {
      this.warmupRemaining -= duration
      return null
    }

    this.samples.push(duration)
    this.sampleSum += duration
    if (this.samples.length > 30) this.sampleSum -= this.samples.shift()!
    if (this.samples.length < 12) return null
    const mean = this.sampleSum / this.samples.length
    this.slowDuration = mean > 21.5 ? this.slowDuration + duration : 0
    this.stableDuration = mean <= 18 ? this.stableDuration + duration : 0
    const index = TIERS.indexOf(quality)

    if (this.slowDuration >= 2_500 && index > 0) {
      const failures = (this.failures[quality] ?? 0) + 1
      this.failures[quality] = failures
      // A failed promotion retreats one tier, then waits 1, 2, 4… minutes before
      // trying that same tier again. The cap still lets a changed workload recover.
      this.retryAfter[quality] = this.activeTime + Math.min(600_000, 60_000 * 2 ** Math.min(failures - 1, 4))
      this.resetWindow()
      return TIERS[index - 1]
    }

    if (this.stableDuration >= 30_000) {
      this.failures[quality] = 0
      this.retryAfter[quality] = 0
    }
    const next = TIERS[index + 1]
    if (next && this.stableDuration >= RECOVERY_MS[quality] && this.activeTime >= (this.retryAfter[next] ?? 0)) {
      this.failures[quality] = 0
      this.retryAfter[quality] = 0
      this.resetWindow()
      return next
    }
    return null
  }
}
