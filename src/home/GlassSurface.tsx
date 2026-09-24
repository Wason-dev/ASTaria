import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { glassDisplacement, HOME_GLASS } from './glass'

export type GlassMaterial = { transmission: number; blur: number; rim: number; shadow: number; reflection?: number }
type Props = { width: number; height: number; radius: number; progress?: number; material?: GlassMaterial; responsive?: boolean }

/** A departing panel releases its live background sampling in the same React commit. */
export const GlassSamplingContext = createContext(true)

export function MeasuredGlassSurface({ radius, progress = 0, material, settleResize = false }: Pick<Props, 'radius' | 'progress' | 'material'> & { settleResize?: boolean }) {
  const sampling = useContext(GlassSamplingContext)
  const host = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState(() => settleResize ? { width: 320, height: 640 } : { width: 1, height: 1 })
  useLayoutEffect(() => {
    const element = host.current
    if (!element || !sampling) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      // Layout dimensions exclude entry/exit transforms on the panel.
      const next = { width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) }
      // A collapsed chat track has no usable edge texture yet. Stretch the
      // initial texture with its live viewport until the opening settles.
      if (settleResize && (next.width < 32 || next.height < 32)) return
      setSize(current => current.width === next.width && current.height === next.height ? current : next)
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      if (settleResize) timer = setTimeout(measure, 120)
      else measure()
    })
    observer.observe(element)
    measure()
    return () => { observer.disconnect(); clearTimeout(timer) }
  }, [sampling, settleResize])
  return <span ref={host} className="home-glass-measure" aria-hidden="true">
    <GlassSurface width={size.width} height={size.height} radius={radius} progress={progress} material={material} responsive={settleResize} />
  </span>
}

/** Optics belong to the UI layer; P0's render targets and shaders stay independent. */
export function GlassSurface({ width, height, radius, progress = 0, material, responsive = false }: Props) {
  const sampling = useContext(GlassSamplingContext)
  const id = `home-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  // Chromium composites SVG backdrop filters over the existing WebGL canvas.
  // Other engines keep the same transparent material with a 2px blur fallback.
  const svgBackdrop = /Chrome|Chromium|Edg\//.test(navigator.userAgent)
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
    {sampling && <svg className="home-glass-definitions" aria-hidden="true" width={responsive ? '100%' : width} height={responsive ? '100%' : height}>
      <defs><filter id={id} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
        <feImage href={map} x="0" y="0" width={responsive ? '100%' : width} height={responsive ? '100%' : height} preserveAspectRatio="none" result="edge" />
        <feDisplacementMap in="soft" in2="edge" scale={HOME_GLASS.refraction * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>}
    <span className="home-glass-surface" style={style} aria-hidden="true" />
  </>
}
