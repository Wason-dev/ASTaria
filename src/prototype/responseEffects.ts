export type ResponseEffectSettings = {
  style: 'tide' | 'filaments' | 'stardust' | 'off'
  intensity: 'gentle' | 'standard' | 'vivid'
  motion: 'system' | 'reduced' | 'full'
}

export type ResponsePhase = 'idle' | 'thinking' | 'replying'

export const DEFAULT_RESPONSE_EFFECT: Readonly<ResponseEffectSettings> = {
  style: 'tide', intensity: 'gentle', motion: 'system',
}

const INTENSITY = { gentle: 0.42, standard: 0.7, vivid: 1 } as const
const STYLE_INDEX = { tide: 0, filaments: 1, stardust: 2 } as const
const EPSILON = 0.001

export function normalizeResponseEffect(value: Partial<ResponseEffectSettings> | null | undefined): ResponseEffectSettings {
  return {
    style: value?.style && ['tide', 'filaments', 'stardust', 'off'].includes(value.style) ? value.style : DEFAULT_RESPONSE_EFFECT.style,
    intensity: value?.intensity && ['gentle', 'standard', 'vivid'].includes(value.intensity) ? value.intensity : DEFAULT_RESPONSE_EFFECT.intensity,
    motion: value?.motion && ['system', 'reduced', 'full'].includes(value.motion) ? value.motion : DEFAULT_RESPONSE_EFFECT.motion,
  }
}

function approach(value: number, target: number, response: number, delta: number) {
  const next = target + (value - target) * Math.exp(-response * delta)
  return Math.abs(next - target) < EPSILON ? target : next
}

/** Only knows presentation state. No chat text, tokens, task data or network timing. */
export class ResponseEffectController {
  private settings: ResponseEffectSettings = { ...DEFAULT_RESPONSE_EFFECT }
  private phase: ResponsePhase = 'idle'
  private amount = 0
  private reply = 0
  private intensity: number = INTENSITY.gentle
  private readonly weights = [1, 0, 0]
  private time = 0

  setSettings(settings: ResponseEffectSettings) {
    this.settings = normalizeResponseEffect(settings)
    // Off is an explicit visual stop, including any previous style's afterglow.
    if (this.settings.style === 'off') {
      this.amount = 0
      this.time = 0
    }
  }

  setPhase(phase: ResponsePhase) {
    if (phase === this.phase) return
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
    if (this.isReduced(systemReduced) || paused || this.settings.style === 'off') return false
    return this.phase !== 'idle' || this.amount > 0
  }

  getSnapshot(systemReduced = false) {
    const reduced = this.isReduced(systemReduced)
    return {
      settings: { ...this.settings },
      phase: this.phase,
      amount: this.amount,
      strength: this.amount * this.intensity * (reduced ? 0.4 : 1),
      reply: this.reply,
      weights: [...this.weights] as [number, number, number],
      time: reduced ? 0 : this.time,
      reducedMotion: reduced,
    }
  }
}
