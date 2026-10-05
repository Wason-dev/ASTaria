export type GlassRendering = 'auto' | 'detailed'

/** Windows D3D11 composites native blur much more efficiently than SVG displacement. */
export function supportsGlassRefraction(userAgent: string, rendering: GlassRendering = 'auto') {
  return /Chrome|Chromium|Edg\//.test(userAgent) && (rendering === 'detailed' || !/Windows/.test(userAgent))
}
