/**
 * State shared by the Parallel Worlds decision studio and the WebGL black hole.
 * The event is deliberately tiny: callers can scrub it at pointer speed without
 * coupling the studio to the renderer's lifecycle.
 */
export interface DecisionEffectDetail {
  active: boolean
  /** Normalized horizon: 0 = now, 1 = the farthest point in the scenario. */
  horizon: number
  /** 0 = do it today, 1 = split it, 2 = postpone it. */
  branch: 0 | 1 | 2
  /** Hold the original route while comparing it with the selected route. */
  comparing: boolean
  /** 0..1 visual emphasis for the currently inspected consequence. */
  emphasis: number
}

export const DECISION_EFFECT_EVENT = 'astaria:decision-effect'
export const DECISION_EXIT_EVENT = 'astaria:decision-exit'
export const DECISION_ENTER_MS = 1800
export const DECISION_EXIT_MS = DECISION_ENTER_MS
// The homepage camera is halfway through its visible travel at about 480ms.
// Hand navigation over here while the remaining optical motion settles.
export const DECISION_REVEAL_MS = 480
// The next workspace is prepared before handover. Finish the outgoing document
// here so it cannot bleed through the destination's transparent glass. The
// optical retreat continues independently until DECISION_EXIT_MS.
export const DECISION_CONTENT_EXIT_MS = DECISION_REVEAL_MS

export const DEFAULT_DECISION_EFFECT: DecisionEffectDetail = {
  active: false,
  horizon: 0,
  branch: 0,
  comparing: false,
  emphasis: 0,
}

export function normalizeDecisionEffect(value: Partial<DecisionEffectDetail> | null | undefined): DecisionEffectDetail {
  const branch = value?.branch === 1 || value?.branch === 2 ? value.branch : 0
  return {
    active: value?.active === true,
    horizon: Number.isFinite(value?.horizon) ? Math.min(1, Math.max(0, Number(value?.horizon))) : 0,
    branch,
    comparing: value?.comparing === true,
    emphasis: Number.isFinite(value?.emphasis) ? Math.min(1, Math.max(0, Number(value?.emphasis))) : 0,
  }
}

/** Broadcast a scrubbed decision state to whichever renderer is mounted. */
export function setDecisionEffect(detail: Partial<DecisionEffectDetail>): DecisionEffectDetail {
  const state = normalizeDecisionEffect(detail)
  currentDecisionEffect = state
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<DecisionEffectDetail>(DECISION_EFFECT_EVENT, { detail: state }))
  }
  return state
}

/** Begin the shared UI/GPU retreat; final active:false remains a hard cleanup. */
export function beginDecisionExit(): void {
  // A renderer mounted during the retreat must not resurrect the old route.
  currentDecisionEffect = { ...DEFAULT_DECISION_EFFECT }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DECISION_EXIT_EVENT))
}

// Keep the latest request across React child/parent effect ordering. The
// renderer may mount just after the studio dispatches its first state.
let currentDecisionEffect: DecisionEffectDetail = { ...DEFAULT_DECISION_EFFECT }
export function getDecisionEffect(): DecisionEffectDetail {
  return { ...currentDecisionEffect }
}

function approach(value: number, target: number, rate: number, delta: number) {
  const next = target + (value - target) * Math.exp(-rate * delta)
  return Math.abs(next - target) < 0.0001 ? target : next
}

function transitionProgress(seconds: number) {
  // Match the homepage's critically damped camera (omega=3.5). Only finish
  // its small remaining tail on a finite clock so navigation can complete.
  const tail = Math.min(1, Math.max(0, (seconds - 1.4) / .4))
  const settled = tail * tail * tail * (tail * (tail * 6 - 15) + 10)
  return 1 - (1 + 3.5 * seconds) * Math.exp(-3.5 * seconds) * (1 - settled)
}

/** Interruptible, frame-rate independent shape transitions; no network clock. */
export class DecisionEffectController {
  private detail: DecisionEffectDetail = { ...DEFAULT_DECISION_EFFECT }
  private strength = 0
  private horizon = 0
  private branch = 0
  private comparison = 0
  private emphasis = 0
  private time = 0
  private exiting = false
  private exitElapsed = 0
  private exitStrength = 0
  private enterElapsed = 0
  private enterStrength = 0

  setDetail(detail: Partial<DecisionEffectDetail>) {
    if (!this.detail.active || this.exiting) {
      this.enterElapsed = 0
      this.enterStrength = this.strength
    }
    this.detail = normalizeDecisionEffect(detail)
    this.exiting = false
    this.exitElapsed = 0
    this.exitStrength = 0
    if (!this.detail.active) {
      // Navigation must not leave a delayed distortion on the homepage.
      this.strength = 0
      this.horizon = 0
      this.branch = 0
      this.comparison = 0
      this.emphasis = 0
      this.time = 0
      this.enterElapsed = 0
      this.enterStrength = 0
    }
  }

  beginExit(reducedMotion = false, paused = false) {
    if (!this.detail.active || this.exiting) return
    if (reducedMotion || paused || this.strength === 0) {
      this.setDetail({ active: false })
      return
    }
    this.exiting = true
    this.exitElapsed = 0
    this.exitStrength = this.strength
  }

  advance(seconds: number, reducedMotion = false, paused = false) {
    if (!this.detail.active) return
    const elapsed = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
    const delta = Math.min(.1, elapsed)
    const immediate = reducedMotion || paused
    if (this.exiting) {
      // Use actual elapsed time for the finite retreat, including a long
      // frame; the ambient clock still avoids fast-forwarding after stalls.
      this.exitElapsed += elapsed
      const progress = Math.min(1, this.exitElapsed / (DECISION_EXIT_MS / 1000))
      if (immediate || progress >= 1 - 1e-9) {
        this.setDetail({ active: false })
        return
      }
      const eased = transitionProgress(this.exitElapsed)
      this.strength = this.exitStrength * (1 - eased)
      this.time += delta
      return
    }
    const move = (value: number, target: number, rate: number) => immediate ? target : approach(value, target, rate, delta)
    this.enterElapsed = immediate ? DECISION_ENTER_MS / 1000 : Math.min(DECISION_ENTER_MS / 1000, this.enterElapsed + elapsed)
    this.strength = this.enterStrength + (1 - this.enterStrength) * transitionProgress(this.enterElapsed)
    this.horizon = move(this.horizon, this.detail.horizon, 16)
    this.branch = move(this.branch, this.detail.branch, 8)
    this.comparison = move(this.comparison, this.detail.comparing ? 1 : 0, 13)
    this.emphasis = move(this.emphasis, this.detail.emphasis, 12)
    if (!immediate) this.time += delta
  }

  needsFrame(reducedMotion = false, paused = false) {
    return this.detail.active && !reducedMotion && !paused
  }

  getSnapshot(reducedMotion = false) {
    const deformation = this.strength * (1 - this.comparison)
    const horizon = this.horizon
    const split = Math.max(0, 1 - Math.abs(this.branch - 1))
    const defer = Math.max(0, this.branch - 1)
    const today = Math.max(0, 1 - this.branch)
    return {
      ...this.detail,
      exiting: this.exiting,
      exitProgress: this.exiting ? Math.min(1, this.exitElapsed / (DECISION_EXIT_MS / 1000)) : 0,
      strength: this.strength,
      renderedHorizon: horizon,
      renderedBranch: this.branch,
      comparison: this.comparison,
      renderedEmphasis: this.emphasis,
      deformation,
      // Physical coordinate scaling, in black-hole Schwarzschild radii.
      radiusScale: 1 + deformation * (0.035 + horizon * .20) * (-today * .42 + split * .3 + defer),
      warpHeight: deformation * (0.12 + horizon * 1.3) * (.65 + split * .1 + defer * .5),
      diskThickness: 1 + deformation * (.1 + horizon * .65) * (.7 + defer * .4),
      lensStrength: deformation * (.06 + horizon * .16) * (.7 + this.emphasis * .6),
      flowSpeed: 1 + deformation * (.12 + horizon * .22) * (.8 + split * .15 + defer * .3),
      inclinationOffset: this.strength === 0 ? 0 : -this.strength * (8 + horizon * 22),
      time: reducedMotion ? 0 : this.time,
      reducedMotion,
    }
  }
}
