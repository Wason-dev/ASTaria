export type OrbitTuning = {
  arcDegrees: number
  rotationDegrees: number
  tiltDegrees: number
  flatten: number
  scale: number
  centerX: number
  centerY: number
  gap: number
  diskWidth: number
  brightness: number
  glow: number
  flow: number
  wave: number
  exitSeconds: number
}

export const ORBIT_TUNING_LIMITS: Record<keyof OrbitTuning, readonly [number, number]> = {
  arcDegrees: [1, 360], rotationDegrees: [-180, 180], tiltDegrees: [-70, 70],
  flatten: [.12, 1], scale: [.45, 1.65], centerX: [-.25, 1.25], centerY: [0, 1],
  gap: [.12, .32], diskWidth: [0, 1], brightness: [.25, 2], glow: [0, 1.5],
  flow: [0, 2], wave: [0, 2], exitSeconds: [1.4, 4],
}

export const DEFAULT_ORBIT_TUNING: OrbitTuning = {
  arcDegrees: 250, rotationDegrees: 0, tiltDegrees: -6, flatten: .5, scale: .82,
  centerX: .43, centerY: .53, gap: .25, diskWidth: 0, brightness: 1,
  glow: 0, flow: .2, wave: .5, exitSeconds: 2.4,
}

const HOME_DISK_TUNING: OrbitTuning = { ...DEFAULT_ORBIT_TUNING, arcDegrees: 360, tiltDegrees: -12, flatten: .42,
  scale: .9, centerX: .5, gap: .22, diskWidth: .9, brightness: 1.1, glow: .65, flow: .6, wave: 1 }

export const ORBIT_TUNING_PRESETS = [
  { id: 'minimal', name: '极简弧线', value: DEFAULT_ORBIT_TUNING },
  { id: 'home', name: '首页盘面', value: HOME_DISK_TUNING },
  { id: 'arcs', name: '三日弧线', value: { ...DEFAULT_ORBIT_TUNING, arcDegrees: 168, tiltDegrees: -7, flatten: .46, scale: 1.55, centerX: -.02, centerY: .59, diskWidth: .28, brightness: .9 } },
  { id: 'rings', name: '舒展星环', value: { ...DEFAULT_ORBIT_TUNING, arcDegrees: 320, tiltDegrees: 0, flatten: .78, scale: .85, centerY: .54, diskWidth: .45 } },
] as const

export function normalizeOrbitTuning(value: unknown): OrbitTuning {
  const source = value && typeof value === 'object' ? value as Partial<OrbitTuning> : {}
  const normalized = { ...DEFAULT_ORBIT_TUNING }
  for (const key of Object.keys(normalized) as Array<keyof OrbitTuning>) {
    const candidate = source[key], [min, max] = ORBIT_TUNING_LIMITS[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) normalized[key] = Math.max(min, Math.min(max, candidate))
  }
  return normalized
}

// The new visual direction has its own defaults; previous disk settings remain
// stored under v1 so trying this design does not overwrite that experiment.
const STORAGE_KEY = 'astaria-orbit-tuning-v2-minimal'
export function readOrbitTuning(): OrbitTuning {
  try { return normalizeOrbitTuning(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')) }
  catch { return { ...DEFAULT_ORBIT_TUNING } }
}
export function saveOrbitTuning(value: OrbitTuning): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeOrbitTuning(value))); return true }
  catch { return false }
}
