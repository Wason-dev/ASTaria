import { createContext, useContext, useId, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, Ref } from 'react'
import { glassDisplacement, HOME_GLASS } from './glass'
import { glassBackdropFilter, glassBlurFilter, supportsGlassRefraction } from './glassRendering'
import type { GlassRendering } from './glassRendering'
import { observePageActivity, pageIsVisible } from '../stores/pageActivity'
import { observeSceneFrames } from '../stores/sceneFrames'

export type GlassMaterial = { transmission: number; blur: number; rim: number; shadow: number; reflection?: number }
export type GlassGeometryHandle = { update: (width: number, height: number, radius: number, progress: number) => void; pause: (width?: number, height?: number) => void }
type Props = { width: number; height: number; radius: number; progress?: number; material?: GlassMaterial; responsive?: boolean; geometryRef?: Ref<GlassGeometryHandle> }

/** A departing panel releases its live background sampling in the same React commit. */
export const GlassSamplingContext = createContext(true)
export const GlassRenderingContext = createContext<GlassRendering>('auto')

export function MeasuredGlassSurface({ radius, progress = 0, material, settleResize = false }: Pick<Props, 'radius' | 'progress' | 'material'> & { settleResize?: boolean }) {
  const sampling = useContext(GlassSamplingContext)
  const rendering = useContext(GlassRenderingContext)
  const host = useRef<HTMLSpanElement>(null)
  const geometry = useRef<GlassGeometryHandle>(null)
  useLayoutEffect(() => {
    const element = host.current
    // Native CSS blur follows its own box. Only the SVG texture needs measured
    // dimensions; observing CSS-only glass needlessly forces layout on entry.
    if (!element || !sampling || !supportsGlassRefraction(navigator.userAgent, rendering)) return
    let lastWidth = 0, lastHeight = 0
    let initialMeasurement = true
    let settleTimer: number | undefined
    const measure = (entries?: ResizeObserverEntry[]) => {
      if (!pageIsVisible()) return
      // Both sources exclude entry/exit transforms but retain fractional CSS
      // pixels. clientWidth rounds away up to half a pixel at the right/bottom
      // filter boundary, leaving a moving unfiltered seam beside the rim.
      const box = entries?.find(entry => entry.target === element)?.contentRect
      const style = box ? undefined : getComputedStyle(element)
      const width = Math.max(1, box?.width ?? (parseFloat(style!.width) || element.clientWidth))
      const height = Math.max(1, box?.height ?? (parseFloat(style!.height) || element.clientHeight))
      if (settleResize && (width < 32 || height < 32)) return
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width; lastHeight = height
      if (settleResize && !initialMeasurement) {
        // During a height transition, retain the glass material without
        // stretching an obsolete map or encoding a PNG on every frame.
        geometry.current?.pause(width, height)
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => geometry.current?.update(lastWidth, lastHeight, radius, progress), 100)
      } else geometry.current?.update(width, height, radius, progress)
      // A retained page's first measurement is its current layout, not an
      // animated resize. Restore accurate optics before its first visible paint.
      initialMeasurement = false
    }
    const observer = new ResizeObserver(measure)
    const activity = () => {
      observer.disconnect()
      window.clearTimeout(settleTimer)
      if (!pageIsVisible()) return
      // The resumed box may have changed while ResizeObserver was detached.
      initialMeasurement = true; lastWidth = 0; lastHeight = 0
      observer.observe(element)
      measure()
    }
    const unobserve = observePageActivity(activity)
    activity()
    return () => { unobserve(); observer.disconnect(); window.clearTimeout(settleTimer) }
  }, [sampling, settleResize, radius, progress, rendering])
  return <span ref={host} className="home-glass-measure" style={{ '--glass-shadow': (material?.shadow ?? HOME_GLASS.shadow) / 100 } as CSSProperties} aria-hidden="true">
    <GlassSurface width={1} height={1} radius={radius} progress={progress} material={material} responsive geometryRef={geometry} />
  </span>
}

/** Optics belong to the UI layer; P0's render targets and shaders stay independent. */
export function GlassSurface({ width, height, radius, progress = 0, material, responsive = false, geometryRef }: Props) {
  const sampling = useContext(GlassSamplingContext)
  const id = `home-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const rendering = useContext(GlassRenderingContext)
  const svgBackdrop = supportsGlassRefraction(navigator.userAgent, rendering)
  const svg = useRef<SVGSVGElement>(null)
  const filter = useRef<SVGFilterElement>(null)
  const edge = useRef<SVGFEImageElement>(null)
  const displacement = useRef<SVGFEDisplacementMapElement>(null)
  const backdrop = useRef<HTMLSpanElement>(null)
  const surface = useRef<HTMLSpanElement>(null)
  const lastGeometry = useRef('')
  const geometry = useRef({ width, height, radius, progress })
  const paused = useRef(false)
  const enabled = useRef(sampling)
  const mobile = Boolean(document.documentElement.dataset.mobile)
  useLayoutEffect(() => { enabled.current = sampling }, [sampling])
  const useBackdrop = (value: string) => {
    const style = backdrop.current?.style
    if (!style) return
    if (style.getPropertyValue('backdrop-filter') !== value) style.setProperty('backdrop-filter', value)
    if (style.getPropertyValue('-webkit-backdrop-filter') !== value) style.setProperty('-webkit-backdrop-filter', value)
  }
  const setDimensions = (w: number, h: number) => {
    for (const element of [svg.current, filter.current, edge.current]) {
      if (element?.getAttribute('width') !== String(w)) element?.setAttribute('width', String(w))
      if (element?.getAttribute('height') !== String(h)) element?.setAttribute('height', String(h))
    }
  }
  const sync = () => {
    if (!backdrop.current) return
    const active = enabled.current && pageIsVisible()
    if (backdrop.current.dataset.sampling !== String(active)) backdrop.current.dataset.sampling = String(active)
    if (!active) { useBackdrop('none'); return }
    const { width: nextWidth, height: nextHeight, radius: nextRadius } = geometry.current
    // Measured glass has no valid texture until its first actual layout. Do
    // not encode a 1x1 placeholder or expose it as a responsive edge map.
    if (responsive && nextWidth === 1 && nextHeight === 1) {
      useBackdrop(glassBlurFilter(material?.blur ?? HOME_GLASS.blur))
      return
    }
    // The camera moves only these optical attributes, with the same rounded
    // edge formula as a React render. No stretched corner or lower-quality map.
    const w = Math.max(1, Math.round(nextWidth)), h = Math.max(1, Math.round(nextHeight))
    const key = `${w}:${h}:${nextRadius}`
    if (svgBackdrop) {
      // Texture storage is integer-sized; the SVG sampling region and image
      // placement must follow the real CSS box, including its fractional edge.
      setDimensions(Math.max(1, nextWidth), Math.max(1, nextHeight))
      if (!paused.current && (lastGeometry.current !== key || !edge.current?.getAttribute('href'))) {
        const map = glassDisplacement(w, h, nextRadius)
        if (map && edge.current) {
          if (edge.current.getAttribute('href') !== map) edge.current.setAttribute('href', map)
          lastGeometry.current = key
        }
      }
      // Keep the same sampling pipeline during an animated resize. Neutral
      // displacement replaces the previous CSS/SVG/CSS sampling switch; the
      // full-resolution exact map returns after the existing settle window.
      const scale = String(paused.current ? 0 : HOME_GLASS.refraction * 2)
      if (displacement.current?.getAttribute('scale') !== scale) displacement.current?.setAttribute('scale', scale)
    }
    const blur = material?.blur ?? HOME_GLASS.blur
    useBackdrop(glassBackdropFilter(blur, svgBackdrop && edge.current?.getAttribute('href') ? id : undefined, mobile))
  }
  useImperativeHandle(geometryRef, () => ({ pause(nextWidth, nextHeight) {
    paused.current = true
    geometry.current = { ...geometry.current, width: nextWidth ?? geometry.current.width, height: nextHeight ?? geometry.current.height }
    sync()
  }, update(nextWidth, nextHeight, nextRadius, nextProgress) {
    geometry.current = { width: nextWidth, height: nextHeight, radius: nextRadius, progress: nextProgress }
    paused.current = false
    sync()
    const transmission = material?.transmission ?? HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * nextProgress
    const tint = String(1 - transmission / 100)
    if (surface.current?.style.getPropertyValue('--glass-tint') !== tint) surface.current?.style.setProperty('--glass-tint', tint)
  } }), [sampling, svgBackdrop, material])
  useLayoutEffect(() => {
    if (!responsive) {
      // Some camera consumers publish rounded texture dimensions to React
      // after already placing the host at a fractional CSS size. Preserve the
      // actual optical bounds on that final commit too (never a transformed
      // getBoundingClientRect measurement).
      const box = svgBackdrop && enabled.current && pageIsVisible() && backdrop.current ? getComputedStyle(backdrop.current) : undefined
      geometry.current = { width: parseFloat(box?.width ?? '') || width, height: parseFloat(box?.height ?? '') || height, radius, progress }
      paused.current = false
    }
  }, [width, height, radius, progress, responsive, svgBackdrop])
  useLayoutEffect(() => {
    // Reattach a filter, change material or restore a WebView using the last
    // committed geometry, including imperative camera updates.
    sync()
    return observePageActivity(sync)
  }, [sampling, svgBackdrop, material, width, height, radius, progress, responsive])
  useLayoutEffect(() => {
    if (!mobile || !sampling || !svgBackdrop) return
    let decimal = false
    return observeSceneFrames(() => {
      const resource = filter.current
      if (!resource || !enabled.current || !pageIsVisible()) return
      // Chromium can reuse an incompletely damaged SVG backdrop after a WebGL
      // presentation: the bottom edge then only repaints on the blinking caret.
      // These two attribute spellings both parse to exactly zero. Invalidate
      // the cached SVG resource without changing geometry, optics or its PNG.
      // Only real scene frames notify us; CSS glass, hidden panels and a paused
      // scene do no work, and foreground text is never put on a moving layer.
      decimal = !decimal
      resource.setAttribute('x', decimal ? '0.0' : '0')
    })
  }, [mobile, sampling, svgBackdrop])
  const transmission = material?.transmission ?? HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * progress
  const blur = material?.blur ?? HOME_GLASS.blur
  const style = {
    '--glass-tint': 1 - transmission / 100,
    // One mobile tint applies to main panels, portal dialogs and value choosers.
    // Only its alpha changes; page theme still owns the original RGB palette.
    ...(mobile ? { backgroundColor: 'var(--mobile-glass-fill, rgb(8 10 14 / .20))' } : {}),
    '--glass-rim': (material?.rim ?? HOME_GLASS.rim) / 100,
    '--glass-reflection': (material?.reflection ?? HOME_GLASS.reflection) / 100,
    '--glass-shadow': (material?.shadow ?? HOME_GLASS.shadow) / 100,
  } as CSSProperties
  return <>
    {/* Retain the decoded edge resource while inactive; sampling itself is
        detached by sync(). Returning must not wait for a new SVG image load. */}
    {svgBackdrop && <svg ref={svg} className="home-glass-definitions" aria-hidden="true" width={responsive ? '100%' : width} height={responsive ? '100%' : height}>
      <defs><filter ref={filter} id={id} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={mobile ? 0 : blur} result="soft" />
        <feImage ref={edge} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} preserveAspectRatio="none" result="edge" />
        <feDisplacementMap ref={displacement} in="soft" in2="edge" scale={HOME_GLASS.refraction * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>}
    {/* Sampling has no animated tint, reflection or masked descendants. Keep
        those on a sibling so rim/entry animation cannot rebuild its backdrop. */}
    <span ref={backdrop} className="home-glass-backdrop" data-sampling={sampling && pageIsVisible()} aria-hidden="true" />
    <span ref={surface} className="home-glass-surface" style={style} aria-hidden="true" />
  </>
}
