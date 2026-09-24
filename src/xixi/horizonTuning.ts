export type HorizonTuning = {
  height: number
  curvature: number
  thickness: number
  brightness: number
  glow: number
  flow: number
  wave: number
  exitSeconds: number
}

export const DEFAULT_HORIZON_TUNING: HorizonTuning = {
  height: .62, curvature: .16, thickness: 22, brightness: 1,
  glow: .8, flow: .8, wave: .5, exitSeconds: 2.6,
}
export const HORIZON_LIMITS: Record<keyof HorizonTuning, readonly [number, number]> = {
  height: [.38, .78], curvature: [.04, .4], thickness: [8, 52],
  brightness: [.4, 1.6], glow: [0, 1.5], flow: [0, 2], wave: [0, 3], exitSeconds: [1.4, 4],
}
export function normalizeHorizonTuning(value: unknown): HorizonTuning {
  const source = value && typeof value === 'object' ? value as Partial<HorizonTuning> : {}
  const next = { ...DEFAULT_HORIZON_TUNING }
  for (const key of Object.keys(next) as Array<keyof HorizonTuning>) {
    const n = source[key], [min, max] = HORIZON_LIMITS[key]
    if (typeof n === 'number' && Number.isFinite(n)) next[key] = Math.min(max, Math.max(min, n))
  }
  return next
}
const STORAGE_KEY = 'astaria-event-horizon-appearance-v1'
export function readHorizonTuning(): HorizonTuning {
  try { return normalizeHorizonTuning(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_HORIZON_TUNING } }
}
export function saveHorizonTuning(value: HorizonTuning): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeHorizonTuning(value))); return true }
  catch { return false }
}
