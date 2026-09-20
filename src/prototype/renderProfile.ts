export type RenderProfile = 'full' | 'smooth90' | 'smooth120' | 'balanced' | 'economy' | 'rest'

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
  rest: { quality: 'safe', frameRate: 20 },
}

export function normalizeRenderProfile(value: unknown): RenderProfile {
  return typeof value === 'string' && value in RENDER_PROFILES ? value as RenderProfile : 'full'
}
