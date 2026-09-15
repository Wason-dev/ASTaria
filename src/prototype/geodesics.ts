/**
 * Schwarzschild null-geodesic transfer table, in units of the horizon radius.
 *
 * Every ray lies in the plane through the observer, the ray, and the origin.
 * Its inverse radius u = 1 / r obeys u'' + u = 3 u² / 2, where the independent
 * variable is angle in that plane. A texture of this equation replaces a
 * per-fragment ray march without replacing the underlying curved ray paths.
 *
 * This models a non-rotating black hole. It does not claim Kerr frame dragging
 * or a radiation/fluid simulation.
 */
export const CRITICAL_IMPACT = Math.sqrt(27) / 2

export interface GeodesicLutOptions {
  /** Distance from the camera to the origin; must be outside the photon sphere. */
  cameraRadius: number
  /** Largest impact parameter the rendered camera can produce. */
  maxImpact: number
  /** An even width keeps the singular critical orbit between two samples. */
  width?: number
  height?: number
  /** The texture includes the primary and two successive disk crossings. */
  maxPhi?: number
  /** RK4 subdivisions between texture rows. */
  substeps?: number
}

export interface GeodesicLut {
  width: number
  height: number
  cameraRadius: number
  maxImpact: number
  maxPhi: number
  criticalImpact: number
  /** One float per texel, suitable for a RedFormat texture. */
  inverseRadius: Float32Array
  /**
   * One RGBA texel per impact sample:
   * R = angle at infinity or the horizon; G = captured (1) or escaped (0);
   * B = closest radius reached; A = maximum relative first-integral error.
   */
  termination: Float32Array
  /** Maximum first-integral error outside the horizon across the entire table. */
  maxRelativeEnergyError: number
  /** Rays that did not terminate within the generous integration limit. */
  unterminatedRays: number
}

/** Map an impact parameter to the normalized horizontal texture coordinate. */
export function geodesicImpactCoordinate(impact: number, maxImpact: number): number {
  const delta = impact - CRITICAL_IMPACT
  const span = delta < 0 ? CRITICAL_IMPACT : maxImpact - CRITICAL_IMPACT
  return (1 + Math.cbrt(delta / span)) / 2
}

/** Inverse mapping: cubic sampling resolves the sharp critical photon orbit. */
export function geodesicImpactAt(coordinate: number, maxImpact: number): number {
  const signed = 2 * coordinate - 1
  const span = signed < 0 ? CRITICAL_IMPACT : maxImpact - CRITICAL_IMPACT
  return CRITICAL_IMPACT + span * signed * signed * signed
}

/**
 * The impact parameter seen by a static observer. The lapse correction makes
 * the finite camera distance consistent with Schwarzschild coordinates.
 */
export function geodesicImpactForAngle(sinAngle: number, cameraRadius: number): number {
  return cameraRadius * sinAngle / Math.sqrt(1 - 1 / cameraRadius)
}

export function createGeodesicLut(options: GeodesicLutOptions): GeodesicLut {
  const { cameraRadius, maxImpact } = options
  const width = options.width ?? 1024
  const height = options.height ?? 768
  const maxPhi = options.maxPhi ?? Math.PI * 3
  const substeps = options.substeps ?? 4
  const maxPhysicalImpact = cameraRadius / Math.sqrt(1 - 1 / cameraRadius)
  if (!(cameraRadius > 1.5) || !(maxImpact > CRITICAL_IMPACT) || maxImpact > maxPhysicalImpact) {
    throw new RangeError('Geodesic lookup requires cameraRadius > 1.5 and a physical maxImpact > sqrt(27)/2.')
  }
  if (!Number.isInteger(width) || width < 4 || width % 2 !== 0 || !Number.isInteger(height) || height < 2) {
    throw new RangeError('Geodesic lookup requires an even width >= 4 and height >= 2.')
  }
  if (!(maxPhi > 0) || !Number.isInteger(substeps) || substeps < 1) {
    throw new RangeError('Geodesic lookup requires positive maxPhi and integer substeps >= 1.')
  }

  const inverseRadius = new Float32Array(width * height)
  const termination = new Float32Array(width * 4)
  const rowStep = maxPhi / (height - 1)
  const step = rowStep / substeps
  const maxTerminalPhi = Math.max(maxPhi, Math.PI * 12)
  let maxRelativeEnergyError = 0
  let unterminatedRays = 0

  for (let x = 0; x < width; x++) {
    const impact = geodesicImpactAt(x / (width - 1), maxImpact)
    let u = 1 / cameraRadius
    let phi = 0
    let terminalPhi = 0
    let ended = false
    let maxU = u
    let relativeEnergyError = 0
    // The exactly radial ray is a separate, nonsingular geometric case.
    if (impact < 1e-12) {
      for (let y = 0; y < height; y++) inverseRadius[y * width + x] = 1
      termination.set([0, 1, 1, 0], x * 4)
      continue
    }

    const inverseImpactSquared = 1 / (impact * impact)
    let velocity = Math.sqrt(Math.max(0, inverseImpactSquared - u * u + u * u * u))

    const advance = () => {
      // Fourth-order Runge–Kutta integration of the exact orbit equation.
      const a1 = 1.5 * u * u - u
      const u2 = u + velocity * step * 0.5
      const v2 = velocity + a1 * step * 0.5
      const a2 = 1.5 * u2 * u2 - u2
      const u3 = u + v2 * step * 0.5
      const v3 = velocity + a2 * step * 0.5
      const a3 = 1.5 * u3 * u3 - u3
      const u4 = u + v3 * step
      const v4 = velocity + a3 * step
      const a4 = 1.5 * u4 * u4 - u4
      const nextU = u + step * (velocity + 2 * v2 + 2 * v3 + v4) / 6
      const nextVelocity = velocity + step * (a1 + 2 * a2 + 2 * a3 + a4) / 6

      if (nextU <= 0 || nextU >= 1) {
        const boundary = nextU >= 1 ? 1 : 0
        terminalPhi = phi + step * Math.max(0, Math.min(1, (boundary - u) / (nextU - u)))
        u = boundary
        maxU = Math.max(maxU, boundary)
        ended = true
      } else {
        u = nextU
        velocity = nextVelocity
        maxU = Math.max(maxU, u)
        const integral = velocity * velocity + u * u - u * u * u
        relativeEnergyError = Math.max(relativeEnergyError, Math.abs(integral - inverseImpactSquared) / inverseImpactSquared)
      }
      phi += step
    }

    for (let y = 0; y < height; y++) {
      if (y > 0 && !ended) {
        for (let i = 0; i < substeps && !ended; i++) advance()
      }
      inverseRadius[y * width + x] = u
    }

    // The visible disk uses up to 3π, but near-critical background rays can
    // wind farther. Continue those few orbits to get their actual exit angle.
    while (!ended && phi < maxTerminalPhi) advance()
    if (!ended) {
      unterminatedRays++
      terminalPhi = maxTerminalPhi
    }
    const captured = impact < CRITICAL_IMPACT
    termination.set([terminalPhi, captured ? 1 : 0, 1 / maxU, relativeEnergyError], x * 4)
    maxRelativeEnergyError = Math.max(maxRelativeEnergyError, relativeEnergyError)
  }

  return { width, height, cameraRadius, maxImpact, maxPhi, criticalImpact: CRITICAL_IMPACT,
    inverseRadius, termination, maxRelativeEnergyError, unterminatedRays }
}

/**
 * GLSL lookup mapping (apply texel-center correction to the normalized UV):
 *
 * float delta = impact - uCriticalImpact;
 * float span = delta < 0.0 ? uCriticalImpact : uMaxImpact-uCriticalImpact;
 * float q = sign(delta) * pow(abs(delta)/span, 1.0/3.0);
 * vec2 uv = vec2((q+1.0)*0.5, phi/uMaxPhi);
 * uv = (uv*(uLutSize-1.0)+0.5)/uLutSize;
 * float inverseRadius = texture2D(uOrbitLut, uv).r;
 *
 * Define e1=normalize(cameraPosition) and e2 as the normalized component of
 * the incoming ray perpendicular to e1. For disk normal n, plane crossings
 * are phi0=mod(atan(-dot(e1,n),dot(e2,n))+PI,PI), then phi0+PI, phi0+2*PI.
 * Only accept phi<terminalPhi and radius between the disk's inner and outer
 * radii. Position is (e1*cos(phi)+e2*sin(phi))/inverseRadius. Its derivative
 * gives the local ray direction if needed; the escaped background direction
 * is e1*cos(terminalPhi)+e2*sin(terminalPhi).
 */
