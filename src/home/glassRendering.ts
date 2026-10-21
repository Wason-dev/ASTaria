export type GlassRendering = 'auto' | 'detailed'

/** A zero-radius CSS blur has no optical effect but still creates a backdrop pass. */
export function glassBlurFilter(blur: number) {
  return blur > 0 ? `blur(${blur}px)` : 'none'
}

/** Native blur precedes SVG displacement on mobile; never blur the result
 * twice or prepend `none` to a filter list. An unready map keeps native blur. */
export function glassBackdropFilter(blur: number, filterId?: string, nativeBlur = false) {
  if (!filterId) return glassBlurFilter(blur)
  return `${nativeBlur && blur > 0 ? `${glassBlurFilter(blur)} ` : ''}url("#${filterId}")`
}

/** Windows and Android auto use system glass. Detailed displacement remains
 * explicit on supporting Chromium engines; WebKit keeps its CSS fallback. */
export function supportsGlassRefraction(userAgent: string, rendering: GlassRendering = 'auto') {
  return /Chrome|Chromium|Edg\//.test(userAgent) && (rendering === 'detailed' || !/Windows|Android/.test(userAgent))
}
