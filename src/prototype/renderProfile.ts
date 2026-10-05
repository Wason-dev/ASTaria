export type RenderQuality = 'auto' | 'ultra' | 'high' | 'low' | 'safe'
export type RenderProfile = 'full' | 'smooth90' | 'smooth120' | 'balanced' | 'economy'
export type RenderScene = 'home' | 'workspace'

export type RenderProfileConfig = {
  quality: 'ultra' | 'high' | 'low' | 'safe'
  frameRate: number
}

/**
 * The profile changes how often and at what resolution the animated background
 * is rendered. It does not remove the black-hole shader, refraction, bloom, or
 * response effects, so a lower profile keeps the same visual language while
 * spending less GPU time between frames.
 */
export const RENDER_PROFILES: Record<RenderProfile, RenderProfileConfig> = {
  full: { quality: 'ultra', frameRate: 60 },
  smooth90: { quality: 'ultra', frameRate: 90 },
  smooth120: { quality: 'ultra', frameRate: 120 },
  balanced: { quality: 'high', frameRate: 45 },
  economy: { quality: 'low', frameRate: 30 },
}

export function normalizeRenderProfile(value: unknown): RenderProfile {
  if (value === 'rest') return 'economy'
  return typeof value === 'string' && Object.hasOwn(RENDER_PROFILES, value) ? value as RenderProfile : 'full'
}

export function resolveRenderProfile(profile: RenderProfile, scene: RenderScene): RenderProfileConfig {
  const config = RENDER_PROFILES[normalizeRenderProfile(profile)]
  // Workspaces intentionally cap the ambient scene at 60 FPS to save power.
  // Homepage/chat keep the selected rate; lower profiles are never upgraded.
  // Product contract and rationale: docs/POWER_AND_RENDERING_DECISIONS.md P01.
  return { ...config, frameRate: scene === 'home' ? config.frameRate : Math.min(config.frameRate, 60) }
}

/** Keep a stable cadence across display refresh rates instead of waiting a full
 * interval before requesting RAF, which can miss the next display refresh. */
export function nextRenderDeadline(previous: number, now: number, frameRate: number): number {
  const interval = 1000 / frameRate
  if (previous <= 0) return now + interval
  return previous + Math.max(1, Math.floor((now - previous) / interval) + 1) * interval
}

export function renderFrameIsDue(deadline: number, now: number): boolean {
  // Native RAF timestamps can arrive 1–2 ms ahead of the nominal cadence
  // (measured on ProMotion). A .25 ms gate needlessly skipped those refreshes.
  // The absolute deadline still advances by one full interval, so accepting
  // that refresh does not raise the selected average FPS or replay late frames.
  return deadline <= 0 || now + 2 >= deadline
}
