import { createContext, useContext, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, Ref } from 'react'
import { glassDisplacement, HOME_GLASS } from './glass'
import { glassBlurFilter, supportsGlassRefraction } from './glassRendering'
import type { GlassRendering } from './glassRendering'

export type GlassMaterial = { transmission: number; blur: number; rim: number; shadow: number; reflection?: number }
export type GlassGeometryHandle = { update: (width: number, height: number, radius: number, progress: number) => void; pause: () => void }
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
    let settleTimer: number | undefined
    const measure = () => {
      // Layout dimensions exclude entry/exit transforms on the panel.
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
      if (settleResize && (width < 32 || height < 32)) return
      if (width === lastWidth && height === lastHeight) return
      lastWidth = width; lastHeight = height
      if (settleResize) {
        // During a height transition, retain the glass material without
        // stretching an obsolete map or encoding a PNG on every frame.
        geometry.current?.pause()
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => geometry.current?.update(lastWidth, lastHeight, radius, progress), 100)
      } else geometry.current?.update(width, height, radius, progress)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => { observer.disconnect(); window.clearTimeout(settleTimer) }
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
  const surface = useRef<HTMLSpanElement>(null)
  const lastGeometry = useRef('')
  const useBackdrop = (value: string) => {
    surface.current?.style.setProperty('backdrop-filter', value)
    surface.current?.style.setProperty('-webkit-backdrop-filter', value)
  }
  useImperativeHandle(geometryRef, () => ({ pause() {
    useBackdrop(glassBlurFilter(material?.blur ?? HOME_GLASS.blur))
  }, update(nextWidth, nextHeight, nextRadius, nextProgress) {
    // The camera moves only these optical attributes, with the same rounded
    // edge formula as a React render. No stretched corner or lower-quality map.
    const w = Math.max(1, Math.round(nextWidth)), h = Math.max(1, Math.round(nextHeight))
    const key = `${w}:${h}:${nextRadius}`
    if (sampling && svgBackdrop && lastGeometry.current !== key) {
      lastGeometry.current = key
      for (const element of [svg.current, filter.current, edge.current]) {
        if (element?.getAttribute('width') !== String(w)) element?.setAttribute('width', String(w))
        if (element?.getAttribute('height') !== String(h)) element?.setAttribute('height', String(h))
      }
      const map = glassDisplacement(w, h, nextRadius)
      if (edge.current?.getAttribute('href') !== map) edge.current?.setAttribute('href', map)
    }
    if (sampling) useBackdrop(svgBackdrop && edge.current?.getAttribute('href') ? `url("#${id}")` : glassBlurFilter(material?.blur ?? HOME_GLASS.blur))
    const transmission = material?.transmission ?? HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * nextProgress
    surface.current?.style.setProperty('--glass-tint', String(1 - transmission / 100))
  } }), [sampling, svgBackdrop, material])
  useLayoutEffect(() => { lastGeometry.current = '' }, [sampling, svgBackdrop, width, height, radius])
  // Hidden retained pages can change size with the window or their data. They
  // must not allocate/encode a displacement canvas until sampling resumes.
  const map = useMemo(() => sampling && svgBackdrop ? glassDisplacement(width, height, radius) : '', [width, height, radius, sampling, svgBackdrop])
  const ready = sampling && Boolean(map)
  const transmission = material?.transmission ?? HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * progress
  const blur = material?.blur ?? HOME_GLASS.blur
  const style = {
    '--glass-tint': 1 - transmission / 100,
    '--glass-rim': (material?.rim ?? HOME_GLASS.rim) / 100,
    '--glass-reflection': (material?.reflection ?? HOME_GLASS.reflection) / 100,
    '--glass-shadow': (material?.shadow ?? HOME_GLASS.shadow) / 100,
    backdropFilter: sampling ? ready ? `url("#${id}")` : glassBlurFilter(blur) : 'none',
    WebkitBackdropFilter: sampling ? ready ? `url("#${id}")` : glassBlurFilter(blur) : 'none',
  } as CSSProperties
  return <>
    {sampling && svgBackdrop && <svg ref={svg} className="home-glass-definitions" aria-hidden="true" width={responsive ? '100%' : width} height={responsive ? '100%' : height}>
      <defs><filter ref={filter} id={id} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
        <feImage ref={edge} href={map} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} preserveAspectRatio="none" result="edge" />
        <feDisplacementMap in="soft" in2="edge" scale={HOME_GLASS.refraction * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>}
    <span ref={surface} className="home-glass-surface" style={style} aria-hidden="true" />
  </>
}
