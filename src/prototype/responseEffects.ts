export type BinaryEffectSettings = {
  enabled: boolean
  density: number
  emberBrightness: number
  visibleFraction: number
  sparkFrequency: number
  sparkBrightness: number
  flowSpeed: number
}

export const DEFAULT_BINARY_EFFECT: Readonly<BinaryEffectSettings> = Object.freeze({
  enabled: true, density: 0.55, emberBrightness: 0.12, visibleFraction: 0.015,
  sparkFrequency: 0.08, sparkBrightness: 0.4, flowSpeed: 0.18,
})

export type ResponseEffectSettings = {
  style: 'tide' | 'filaments' | 'stardust' | 'off'
  intensity: 'gentle' | 'standard' | 'vivid'
  motion: 'system' | 'reduced' | 'full'
  binary?: BinaryEffectSettings
}

export type NormalizedResponseEffectSettings = ResponseEffectSettings & { binary: BinaryEffectSettings }

export type ResponsePhase = 'idle' | 'thinking' | 'replying'

export const DEFAULT_RESPONSE_EFFECT: Readonly<NormalizedResponseEffectSettings> = {
  style: 'tide', intensity: 'gentle', motion: 'system',
  binary: DEFAULT_BINARY_EFFECT,
}

const INTENSITY = { gentle: 0.42, standard: 0.7, vivid: 1 } as const
const STYLE_INDEX = { tide: 0, filaments: 1, stardust: 2 } as const
const EPSILON = 0.001
const BINARY_EXIT_SECONDS = 1.2

function binaryAmount(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

export function normalizeBinaryEffect(value: Partial<BinaryEffectSettings> | null | undefined): BinaryEffectSettings {
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : DEFAULT_BINARY_EFFECT.enabled,
    density: binaryAmount(value?.density, DEFAULT_BINARY_EFFECT.density),
    emberBrightness: binaryAmount(value?.emberBrightness, DEFAULT_BINARY_EFFECT.emberBrightness),
    visibleFraction: binaryAmount(value?.visibleFraction, DEFAULT_BINARY_EFFECT.visibleFraction),
    sparkFrequency: binaryAmount(value?.sparkFrequency, DEFAULT_BINARY_EFFECT.sparkFrequency),
    sparkBrightness: binaryAmount(value?.sparkBrightness, DEFAULT_BINARY_EFFECT.sparkBrightness),
    flowSpeed: binaryAmount(value?.flowSpeed, DEFAULT_BINARY_EFFECT.flowSpeed),
  }
}

type ResponseEffectInput = Partial<Omit<ResponseEffectSettings, 'binary'>> & { binary?: Partial<BinaryEffectSettings> | null }
export function normalizeResponseEffect(value: ResponseEffectInput | null | undefined): NormalizedResponseEffectSettings {
  return {
    style: value?.style && ['tide', 'filaments', 'stardust', 'off'].includes(value.style) ? value.style : DEFAULT_RESPONSE_EFFECT.style,
    intensity: value?.intensity && ['gentle', 'standard', 'vivid'].includes(value.intensity) ? value.intensity : DEFAULT_RESPONSE_EFFECT.intensity,
    motion: value?.motion && ['system', 'reduced', 'full'].includes(value.motion) ? value.motion : DEFAULT_RESPONSE_EFFECT.motion,
    binary: normalizeBinaryEffect(value?.binary),
  }
}

function approach(value: number, target: number, response: number, delta: number) {
  const next = target + (value - target) * Math.exp(-response * delta)
  return Math.abs(next - target) < EPSILON ? target : next
}

/** Only knows presentation state. No chat text, tokens, task data or network timing. */
export class ResponseEffectController {
  private settings = normalizeResponseEffect(DEFAULT_RESPONSE_EFFECT)
  private phase: ResponsePhase = 'idle'
  private amount = 0
  private binaryAmount = 0
  private binaryExitFrom = 0
  private binaryExitTime = 0
  private reply = 0
  private intensity: number = INTENSITY.gentle
  private readonly weights = [1, 0, 0]
  private time = 0

  setSettings(settings: ResponseEffectSettings) {
    this.settings = normalizeResponseEffect(settings)
    if (!this.settings.binary.enabled) this.binaryAmount = 0
    // Off is an explicit visual stop, including any previous style's afterglow.
    if (this.settings.style === 'off') {
      this.amount = 0
      this.time = 0
    }
  }

  setPhase(phase: ResponsePhase) {
    if (phase === this.phase) return
    if (this.phase === 'thinking' && phase !== 'thinking') {
      this.binaryExitFrom = this.binaryAmount
      this.binaryExitTime = 0
    }
    if (this.amount === 0 && phase !== 'idle') {
      this.time = 0
      this.reply = phase === 'replying' ? 1 : 0
    }
    this.phase = phase
  }

  private isReduced(systemReduced: boolean) {
    return this.settings.motion === 'reduced' || (this.settings.motion === 'system' && systemReduced)
  }

  advance(seconds: number, systemReduced: boolean, paused = false) {
    const reduced = this.isReduced(systemReduced)
    // Background suspension does not produce a fast-forward burst on return.
    const delta = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 0.1)) : 0
    const target = this.settings.style === 'off' || this.phase === 'idle' ? 0 : 1
    const replyTarget = this.phase === 'idle' ? this.reply : this.phase === 'replying' ? 1 : 0
    const immediate = reduced || paused
    const binaryTarget = this.settings.binary.enabled && this.phase === 'thinking' ? 1 : 0
    if (immediate) this.binaryAmount = binaryTarget
    else if (binaryTarget) this.binaryAmount = approach(this.binaryAmount, 1, 5, delta)
    else if (this.binaryAmount > 0) {
      this.binaryExitTime = Math.min(BINARY_EXIT_SECONDS, this.binaryExitTime + delta)
      const progress = this.binaryExitTime / BINARY_EXIT_SECONDS
      this.binaryAmount = this.binaryExitFrom * (1 - progress * progress * (3 - 2 * progress))
    }
    this.amount = immediate ? target : approach(this.amount, target, target ? 3.2 : 2.2, delta)
    this.reply = immediate ? replyTarget : approach(this.reply, replyTarget, 2.8, delta)
    this.intensity = immediate ? INTENSITY[this.settings.intensity]
      : approach(this.intensity, INTENSITY[this.settings.intensity], 4, delta)
    if (this.settings.style !== 'off') {
      const index = STYLE_INDEX[this.settings.style]
      for (let i = 0; i < this.weights.length; i++) {
        const weight = i === index ? 1 : 0
        this.weights[i] = immediate ? weight : approach(this.weights[i], weight, 4, delta)
      }
    }
    if (!immediate && this.amount > 0) this.time += delta
    if (this.amount === 0) this.time = 0
  }

  needsFrame(systemReduced: boolean, paused = false) {
    if (this.isReduced(systemReduced) || paused) return false
    const binaryActive = this.settings.binary.enabled && this.phase === 'thinking'
    return binaryActive || this.binaryAmount > 0
      || (this.settings.style !== 'off' && (this.phase !== 'idle' || this.amount > 0))
  }

  getSnapshot(systemReduced = false) {
    const reduced = this.isReduced(systemReduced)
    return {
      settings: { ...this.settings, binary: { ...this.settings.binary } },
      phase: this.phase,
      amount: this.amount,
      binaryAmount: this.binaryAmount,
      strength: this.amount * this.intensity * (reduced ? 0.4 : 1),
      reply: this.reply,
      weights: [...this.weights] as [number, number, number],
      time: reduced ? 0 : this.time,
      reducedMotion: reduced,
    }
  }
}
