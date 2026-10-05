export type GlassRendering = 'auto' | 'detailed'

/** A zero-radius CSS blur has no optical effect but still creates a backdrop pass. */
export function glassBlurFilter(blur: number) {
  return blur > 0 ? `blur(${blur}px)` : 'none'
}

/** Windows D3D11 composites native blur much more efficiently than SVG displacement. */
export function supportsGlassRefraction(userAgent: string, rendering: GlassRendering = 'auto') {
  return /Chrome|Chromium|Edg\//.test(userAgent) && (rendering === 'detailed' || !/Windows/.test(userAgent))
}
