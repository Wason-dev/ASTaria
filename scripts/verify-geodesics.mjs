#!/usr/bin/env node
/** Numerical acceptance checks; Node 24 type stripping, no dependencies or GPU. */
import assert from 'node:assert/strict'
import {
  CRITICAL_IMPACT,
  createGeodesicLut,
  geodesicImpactAt,
  geodesicImpactCoordinate,
  geodesicImpactForAngle,
} from '../src/prototype/geodesics.ts'

const settings = { cameraRadius: 30, maxImpact: 24, width: 1536, height: 1024 }
const started = performance.now()
const lut = createGeodesicLut(settings)
const reference = createGeodesicLut({ ...settings, width: 3072, height: 2048 })
const mix = (a, b, t) => a + (b - a) * t
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0)
const normalize = (vector) => vector.map((value) => value / Math.hypot(...vector))
const report = (check, values) => console.log(JSON.stringify({ check, ...values }))
let checks = 0

function sample(table, impact, phi) {
  const sx = geodesicImpactCoordinate(impact, table.maxImpact) * (table.width - 1)
  const sy = Math.max(0, Math.min(1, phi / table.maxPhi)) * (table.height - 1)
  const x = Math.min(table.width - 2, Math.floor(sx))
  const y = Math.min(table.height - 2, Math.floor(sy))
  const row = y * table.width + x
  return mix(
    mix(table.inverseRadius[row], table.inverseRadius[row + 1], sx - x),
    mix(table.inverseRadius[row + table.width], table.inverseRadius[row + table.width + 1], sx - x),
    sy - y,
  )
}

function terminalAngle(table, impact) {
  const sx = geodesicImpactCoordinate(impact, table.maxImpact) * (table.width - 1)
  const x = Math.min(table.width - 2, Math.floor(sx))
  return mix(table.termination[x * 4], table.termination[(x + 1) * 4], sx - x)
}

// Independent reference: integrate the first integral by Simpson quadrature,
// rather than the generator's second-order ODE / Runge–Kutta algorithm.
function integrate(fn, start, end, intervals = 8192) {
  const h = (end - start) / intervals
  let sum = fn(start) + fn(end)
  for (let i = 1; i < intervals; i++) sum += (i % 2 === 0 ? 2 : 4) * fn(start + i * h)
  return sum * h / 3
}

function quadratureTerminal(impact) {
  const u0 = 1 / settings.cameraRadius
  const energy = 1 / (impact * impact)
  if (impact < CRITICAL_IMPACT) {
    return integrate((u) => 1 / Math.sqrt(energy - u * u + u * u * u), u0, 1)
  }
  let lo = 0
  let hi = 2 / 3
  for (let iteration = 0; iteration < 60; iteration++) {
    const u = (lo + hi) / 2
    if (energy - u * u + u * u * u > 0) lo = u
    else hi = u
  }
  const turningU = (lo + hi) / 2
  // u=turningU*(1-t²) removes the square-root endpoint singularity.
  const regularized = (t) => {
    const u = turningU * (1 - t * t)
    return 2 * Math.sqrt(turningU) / Math.sqrt((1 - turningU) * (u + turningU) - u * u)
  }
  return integrate(regularized, 0, 1) + integrate(regularized, 0, Math.sqrt(1 - u0 / turningU))
}

report('configuration', { runtime: process.version, settings, comparisonGrid: [reference.width, reference.height], units: 'horizon radius = 1; orbital angles in radians' })

let invalidTexels = 0
let classificationMismatches = 0
let capturedColumns = 0
let escapedColumns = 0
let maxTurningPolynomialResidual = 0
for (const inverseRadius of lut.inverseRadius) {
  if (!Number.isFinite(inverseRadius) || inverseRadius < 0 || inverseRadius > 1) invalidTexels++
}
for (let x = 0; x < lut.width; x++) {
  const impact = geodesicImpactAt(x / (lut.width - 1), settings.maxImpact)
  const [end, captured, closestRadius, energyError] = lut.termination.slice(x * 4, x * 4 + 4)
  assert.ok(Number.isFinite(end) && end >= 0 && end < 12 * Math.PI)
  assert.ok(Number.isFinite(energyError) && energyError < 1e-8)
  const physicallyCaptured = impact < Math.sqrt(27) / 2
  if ((captured === 1) !== physicallyCaptured || (closestRadius === 1) !== physicallyCaptured) classificationMismatches++
  if (physicallyCaptured) capturedColumns++
  else {
    escapedColumns++
    assert.ok(closestRadius > 1.5, 'escaped null rays must turn outside the photon sphere')
    const residual = Math.abs(closestRadius ** 3 - impact ** 2 * closestRadius + impact ** 2) / closestRadius ** 3
    maxTurningPolynomialResidual = Math.max(maxTurningPolynomialResidual, residual)
  }
}
assert.equal(invalidTexels, 0)
assert.equal(classificationMismatches, 0)
assert.equal(lut.unterminatedRays, 0)
assert.ok(maxTurningPolynomialResidual < 1e-5)
report('horizon_capture_and_escape', { invalidTexels, classificationMismatches, capturedColumns, escapedColumns, unterminatedRays: lut.unterminatedRays, maxTurningPolynomialResidual, maxReportedFirstIntegralRelativeError: lut.maxRelativeEnergyError })
checks++

// Derive du/dφ independently from the actual Float32 texture, excluding cells
// that touch a clamped terminal boundary. This checks serialized data too.
const rowStep = lut.maxPhi / (lut.height - 1)
let finiteDifferenceSamples = 0
let maxFiniteDifferenceEnergyError = 0
for (let x = 1; x < lut.width; x += 7) {
  const impact = geodesicImpactAt(x / (lut.width - 1), settings.maxImpact)
  for (let y = 1; y < lut.height - 1; y += 5) {
    const previous = lut.inverseRadius[(y - 1) * lut.width + x]
    const u = lut.inverseRadius[y * lut.width + x]
    const next = lut.inverseRadius[(y + 1) * lut.width + x]
    if (previous <= 0.005 || next <= 0.005 || previous >= 0.95 || next >= 0.95) continue
    const velocity = (next - previous) / (2 * rowStep)
    const measured = velocity * velocity + u * u - u * u * u
    maxFiniteDifferenceEnergyError = Math.max(maxFiniteDifferenceEnergyError, Math.abs(measured * impact * impact - 1))
    finiteDifferenceSamples++
  }
}
assert.ok(finiteDifferenceSamples > 1000)
assert.ok(maxFiniteDifferenceEnergyError < 0.001, 'stored Float32 paths must preserve the first integral to 0.1% under finite differences')
report('serialized_first_integral', { samples: finiteDifferenceSamples, maxRelativeError: maxFiniteDifferenceEnergyError, tolerance: 0.001 })
checks++

const impactCases = [2, 2.5, CRITICAL_IMPACT - 0.01, CRITICAL_IMPACT - 0.001, CRITICAL_IMPACT + 0.001, CRITICAL_IMPACT + 0.01, 3, 4, 8, 12, 20]
const quadratureResults = impactCases.map((impact) => {
  const observed = terminalAngle(lut, impact)
  const independent = quadratureTerminal(impact)
  return { impact, observed, independent, absoluteError: Math.abs(observed - independent) }
})
const maxQuadratureError = Math.max(...quadratureResults.map((row) => row.absoluteError))
assert.ok(maxQuadratureError < 0.003, 'orbit termination must agree with independent first-integral quadrature within 0.003 rad')
report('independent_terminal_quadrature', { maxAbsoluteErrorRadians: maxQuadratureError, toleranceRadians: 0.003, rays: quadratureResults })
checks++

// Include impacts on both sides very close to the unstable critical orbit.
// We compare path geometry here, not singular background phase at exactly bcrit.
const convergenceImpacts = [0.5, 1, 2, 3, 4, 8, 12, 20]
for (const distance of [1e-6, 1e-5, 1e-4, 1e-3, 0.01, 0.1]) {
  convergenceImpacts.push(CRITICAL_IMPACT - distance, CRITICAL_IMPACT + distance)
}
let maxInverseRadiusDifference = 0
let maxEmittingRadiusRelativeDifference = 0
let emittingSamples = 0
for (const impact of convergenceImpacts) {
  for (let step = 0; step <= 480; step++) {
    const phi = step / 480 * lut.maxPhi
    const coarse = sample(lut, impact, phi)
    const fine = sample(reference, impact, phi)
    // Terminal clamping is discontinuous in its derivative; independently
    // checked terminal angles above cover those cells instead.
    if (fine <= 0.01 || fine >= 0.98) continue
    maxInverseRadiusDifference = Math.max(maxInverseRadiusDifference, Math.abs(coarse - fine))
    if (fine > 1 / 12 && fine < 1 / 3) {
      maxEmittingRadiusRelativeDifference = Math.max(maxEmittingRadiusRelativeDifference, Math.abs(fine / coarse - 1))
      emittingSamples++
    }
  }
}
assert.ok(emittingSamples > 100)
assert.ok(maxInverseRadiusDifference < 0.001)
assert.ok(maxEmittingRadiusRelativeDifference < 0.001)
report('double_resolution_convergence', { impactCases: convergenceImpacts.length, closestCriticalDistance: 1e-6, emittingSamples, maxInverseRadiusDifference, maxEmittingRadiusRelativeDifference, tolerance: 0.001 })
checks++

const inclination = 78 * Math.PI / 180
const radialBasis = [0, Math.cos(inclination), Math.sin(inclination)]
const up = [0, radialBasis[2], -radialBasis[1]]
function crossings(x, y) {
  const direction = normalize(radialBasis.map((value, i) => -6 * value + up[i] * y + (i === 0 ? x : 0)))
  const radialComponent = dot(direction, radialBasis)
  const orbitBasis = normalize(direction.map((value, i) => value - radialComponent * radialBasis[i]))
  const impact = geodesicImpactForAngle(Math.sqrt(Math.max(0, 1 - radialComponent * radialComponent)), settings.cameraRadius)
  const firstPhi = ((Math.atan2(-radialBasis[1], orbitBasis[1]) % Math.PI) + Math.PI) % Math.PI
  const end = terminalAngle(lut, impact)
  const hits = []
  for (let order = 0; order < 3; order++) {
    const phi = firstPhi + order * Math.PI
    const radius = 1 / sample(lut, impact, phi)
    if (phi >= end || radius < 3 || radius > 12) continue
    const point = radialBasis.map((value, i) => radius * (value * Math.cos(phi) + orbitBasis[i] * Math.sin(phi)))
    hits.push({ order, radius, planeResidual: Math.abs(point[1]) })
  }
  return { impact, captured: impact < CRITICAL_IMPACT, hits }
}

let validCrossings = 0
let secondaryCrossings = 0
let maxPlaneResidual = 0
for (let yi = 0; yi <= 80; yi++) {
  for (let xi = 0; xi <= 120; xi++) {
    const x = (xi / 120 - 0.5) * 4
    const y = (yi / 80 - 0.5) * 2
    if (x === 0 && y === 0) continue // the radial ray has no unique orbital plane
    for (const hit of crossings(x, y).hits) {
      validCrossings++
      if (hit.order > 0) secondaryCrossings++
      maxPlaneResidual = Math.max(maxPlaneResidual, hit.planeResidual)
    }
  }
}
const foregroundExample = crossings(0, -0.5)
assert.ok(validCrossings > 1000 && secondaryCrossings > 100)
assert.ok(maxPlaneResidual < 1e-10)
assert.ok(foregroundExample.captured && foregroundExample.hits.some((hit) => hit.order === 0))
report('inclined_disk_intersections', { inclinationDegrees: 78, grid: [121, 81], validCrossings, secondaryCrossings, maxPlaneResidual, foregroundInsideShadow: foregroundExample })
checks++

const criticalAngle = Math.asin(CRITICAL_IMPACT * Math.sqrt(1 - 1 / settings.cameraRadius) / settings.cameraRadius)
const apparentRadiusAt900Px = Math.tan(criticalAngle) * 6 * 900 / 2
assert.ok(apparentRadiusAt900Px > 230 && apparentRadiusAt900Px < 232)
report('shadow_projection', { criticalImpact: CRITICAL_IMPACT, photonSphereRadius: 1.5, criticalAngleDegrees: criticalAngle * 180 / Math.PI, focalLength: 6, shadowRadiusAt900PixelsHigh: apparentRadiusAt900Px })
checks++

report('result', { status: 'PASS', checks, durationMs: performance.now() - started, limitation: 'Numerical Schwarzschild path and camera checks only; does not establish visual quality, Doppler rendering, Kerr physics or browser frame rate.' })
