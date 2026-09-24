export type Spring = { value: number; velocity: number }

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Exact damped-oscillator step; frequency is angular frequency in radians/second. */
export function springStep(
  state: Spring, target: number, dtSeconds: number, frequency = 12, damping = .86,
): Spring {
  const value = finite(state.value)
  const velocity = finite(state.velocity)
  const destination = finite(target, value)
  const dt = clamp(finite(dtSeconds), 0, .1)
  const omega = clamp(finite(frequency, 12), 0, 120)
  const zeta = clamp(finite(damping, .86), 0, 10)
  if (dt === 0) return { value, velocity }
  if (omega === 0) return { value: finite(value + velocity * dt, value), velocity }

  const offset = value - destination
  let nextOffset: number
  let nextVelocity: number
  if (Math.abs(zeta - 1) < 1e-6) {
    const decay = Math.exp(-omega * dt)
    const momentum = velocity + omega * offset
    nextOffset = decay * (offset + momentum * dt)
    nextVelocity = decay * (velocity - omega * momentum * dt)
  } else if (zeta < 1) {
    const attenuation = zeta * omega
    const damped = omega * Math.sqrt(1 - zeta * zeta)
    const decay = Math.exp(-attenuation * dt)
    const sin = Math.sin(damped * dt)
    const cos = Math.cos(damped * dt)
    nextOffset = decay * (offset * cos + (velocity + attenuation * offset) / damped * sin)
    nextVelocity = decay * (velocity * cos - (attenuation * velocity + omega * omega * offset) / damped * sin)
  } else {
    const root = Math.sqrt(zeta * zeta - 1)
    const slow = -omega / (zeta + root)
    const fast = -omega * (zeta + root)
    const slowAmount = (velocity - fast * offset) / (slow - fast)
    const fastAmount = offset - slowAmount
    const slowDecay = Math.exp(slow * dt)
    const fastDecay = Math.exp(fast * dt)
    nextOffset = slowAmount * slowDecay + fastAmount * fastDecay
    nextVelocity = slowAmount * slow * slowDecay + fastAmount * fast * fastDecay
  }
  return {
    value: finite(destination + nextOffset, destination),
    velocity: finite(nextVelocity),
  }
}

export type WavePulse = { day: number; t: number; started: number; strength: number }

/** Radial screen-space displacement: quiet flow, pointer attraction and outward ripples. */
export function orbitWave(
  day: number,
  t: number,
  timeSeconds: number,
  pulses: readonly WavePulse[],
  pointer: { day: number; t: number; strength: number } | null,
  reduced = false,
): number {
  if (reduced || ![day, t, timeSeconds].every(Number.isFinite)) return 0
  let displacement = .55 * Math.sin(t * 13.8 - timeSeconds * .60 + day * .8)
    + .25 * Math.sin(t * 22 + timeSeconds * .36 - day * .55)

  if (pointer && [pointer.day, pointer.t, pointer.strength].every(Number.isFinite)) {
    const distance = t - pointer.t
    const falloff = Math.exp(-.5 * ((distance / .13) ** 2 + ((day - pointer.day) / .65) ** 2))
    displacement += clamp(pointer.strength, 0, 1) * falloff
      * (3.1 + .4 * Math.sin(distance * 26 - timeSeconds * 1.5))
  }

  for (const pulse of pulses) {
    if (![pulse.day, pulse.t, pulse.started, pulse.strength].every(Number.isFinite)) continue
    const age = timeSeconds - pulse.started
    if (age <= 0) continue
    const front = Math.abs(t - pulse.t) - .30 * age
    const envelope = Math.exp(-.5 * ((front / .065) ** 2 + ((day - pulse.day) / .7) ** 2))
    displacement += 1.5 * clamp(pulse.strength, 0, 1) * envelope
      * Math.cos(front * 30) * Math.exp(-age / .8) * (1 - Math.exp(-age * 16))
  }

  // A smooth limiter lets several overlapping ripples merge without a hard-edged clamp.
  return 5 * Math.tanh(displacement / 5)
}
