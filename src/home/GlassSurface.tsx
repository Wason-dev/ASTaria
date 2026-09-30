import { createContext, useContext, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import type { CSSProperties, Ref } from 'react'
import { glassDisplacement, HOME_GLASS } from './glass'

export type GlassMaterial = { transmission: number; blur: number; rim: number; shadow: number; reflection?: number }
export type GlassGeometryHandle = { update: (width: number, height: number, radius: number, progress: number) => void }
type Props = { width: number; height: number; radius: number; progress?: number; material?: GlassMaterial; responsive?: boolean; geometryRef?: Ref<GlassGeometryHandle> }

/** A departing panel releases its live background sampling in the same React commit. */
export const GlassSamplingContext = createContext(true)

export function MeasuredGlassSurface({ radius, progress = 0, material, settleResize = false }: Pick<Props, 'radius' | 'progress' | 'material'> & { settleResize?: boolean }) {
  const sampling = useContext(GlassSamplingContext)
  const host = useRef<HTMLSpanElement>(null)
  const geometry = useRef<GlassGeometryHandle>(null)
  useLayoutEffect(() => {
    const element = host.current
    if (!element || !sampling) return
    const measure = () => {
      // Layout dimensions exclude entry/exit transforms on the panel.
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
      if (settleResize && (width < 32 || height < 32)) return
      // ResizeObserver delivers the current geometry before paint. Updating
      // only the optical attributes avoids React commits during expansion and
      // a stretched old texture snapping into place after a debounce timer.
      geometry.current?.update(width, height, radius, progress)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [sampling, settleResize, radius, progress])
  return <span ref={host} className="home-glass-measure" style={{ '--glass-shadow': (material?.shadow ?? HOME_GLASS.shadow) / 100 } as CSSProperties} aria-hidden="true">
    <GlassSurface width={1} height={1} radius={radius} progress={progress} material={material} responsive geometryRef={geometry} />
  </span>
}

/** Optics belong to the UI layer; P0's render targets and shaders stay independent. */
export function GlassSurface({ width, height, radius, progress = 0, material, responsive = false, geometryRef }: Props) {
  const sampling = useContext(GlassSamplingContext)
  const id = `home-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  // Chromium composites SVG backdrop filters over the existing WebGL canvas.
  // Other engines keep the same transparent material with a 2px blur fallback.
  const svgBackdrop = /Chrome|Chromium|Edg\//.test(navigator.userAgent)
  const svg = useRef<SVGSVGElement>(null)
  const filter = useRef<SVGFilterElement>(null)
  const edge = useRef<SVGFEImageElement>(null)
  const surface = useRef<HTMLSpanElement>(null)
  const lastGeometry = useRef('')
  useImperativeHandle(geometryRef, () => ({ update(nextWidth, nextHeight, nextRadius, nextProgress) {
    // The camera moves only these optical attributes, with the same rounded
    // edge formula as a React render. No stretched corner or lower-quality map.
    const w = Math.max(1, Math.round(nextWidth)), h = Math.max(1, Math.round(nextHeight))
    const key = `${w}:${h}:${nextRadius}`
    if (lastGeometry.current !== key) {
      lastGeometry.current = key
      for (const element of [svg.current, filter.current, edge.current]) {
        element?.setAttribute('width', String(w)); element?.setAttribute('height', String(h))
      }
      if (sampling && svgBackdrop) edge.current?.setAttribute('href', glassDisplacement(w, h, nextRadius))
    }
    const transmission = material?.transmission ?? HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * nextProgress
    surface.current?.style.setProperty('--glass-tint', String(1 - transmission / 100))
  } }), [sampling, svgBackdrop, material])
  useLayoutEffect(() => { lastGeometry.current = '' }, [sampling, width, height, radius])
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
    backdropFilter: sampling ? ready ? `url("#${id}")` : `blur(${blur}px)` : 'none',
    WebkitBackdropFilter: sampling ? ready ? `url("#${id}")` : `blur(${blur}px)` : 'none',
  } as CSSProperties
  return <>
    {sampling && <svg ref={svg} className="home-glass-definitions" aria-hidden="true" width={responsive ? '100%' : width} height={responsive ? '100%' : height}>
      <defs><filter ref={filter} id={id} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
        <feImage ref={edge} href={map} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} preserveAspectRatio="none" result="edge" />
        <feDisplacementMap in="soft" in2="edge" scale={HOME_GLASS.refraction * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>}
    <span ref={surface} className="home-glass-surface" style={style} aria-hidden="true" />
  </>
}
