import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

import { MEDIA_CAMERA_VIEWS, mediaSceneLayout, mediaViewportCoverage, horizonMediaBlend } from '../src/prototype/backgroundMedia.ts'
import { portraitCameraOffset } from '../src/prototype/portraitComposition.ts'
import { sameCameraSample } from '../src/spatial/cameraSample.ts'
import { sceneProjection } from '../src/spatial/scene.ts'

// blackHoleEntryGeometry imports `../spatial/scene` without a Node-resolvable
// extension. Rewrite only that specifier while importing it, exactly like the
// existing home-black-hole-entry regression; every other import already names .ts.
const geometryUrl = new URL('../src/home/blackHoleEntryGeometry.ts', import.meta.url).href
const extensionHook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === geometryUrl && specifier === '../spatial/scene') return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})
const { blackHoleEntryGeometry } = await import(geometryUrl)
extensionHook.deregister()

const PANORAMA = { ...MEDIA_CAMERA_VIEWS.panorama }
const INTERSTELLAR = { ...MEDIA_CAMERA_VIEWS.interstellar }

/** A complete SceneCamera in the shape HomeWorkspace reads from the renderer. */
const sceneCamera = (overrides = {}) => ({
  ...PANORAMA, cameraTransition: false, reducedMotion: false, paused: false, simulationTime: 0, ...overrides,
})
const flightAt = (progress, mode = 'edge') => ({
  progress, mode, edgeFrame: { height: .62, curvature: .16 },
})

/** Relative comparison that still tolerates sub-pixel floating point noise. */
const near = (actual, expected, epsilon = 1e-9) => assert.ok(
  Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(actual), Math.abs(expected)),
  `${actual} ≉ ${expected}`,
)

// Desktop windows, the two portrait phones and landscape phone the layout has to
// serve. "narrow desktop" is still a desktop window; the tall desktop window is
// covered separately because it takes the portrait branch without a mobile offset.
const VIEWPORTS = [
  { label: '16:9 desktop', width: 1920, height: 1080, mobile: false },
  { label: '16:10 desktop', width: 1920, height: 1200, mobile: false },
  { label: 'narrow 4:3 desktop', width: 1024, height: 768, mobile: false },
  { label: 'ultrawide desktop', width: 3440, height: 1440, mobile: false },
  { label: '390x844 phone', width: 390, height: 844, mobile: true },
  { label: '320x844 phone', width: 320, height: 844, mobile: true },
  { label: '844x390 landscape phone', width: 844, height: 390, mobile: true },
]
const PORTRAIT_DESKTOP = { label: '900x1200 portrait desktop window', width: 900, height: 1200, mobile: false }
const ALL_VIEWPORTS = [...VIEWPORTS, PORTRAIT_DESKTOP]

/** Independent geometric contract of one affine media layout. */
function assertAffineCircle(layout, context) {
  const { matrix, sourceCenter, projection } = layout
  const numbers = [
    matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f,
    sourceCenter.x, sourceCenter.y, sourceCenter.radius,
    projection.cx, projection.cy, projection.radius, projection.unit, projection.apexY,
    projection.width, projection.height,
  ]
  assert.ok(numbers.every(Number.isFinite), `${context}: geometry stays finite`)

  // The decoded master may rotate and scale, but never shear, stretch one axis
  // more than the other, or mirror.
  const xScale = Math.hypot(matrix.a, matrix.b)
  const yScale = Math.hypot(matrix.c, matrix.d)
  near(xScale, yScale, 1e-9)
  near(matrix.a * matrix.c + matrix.b * matrix.d, 0, 1e-9)
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  assert.ok(determinant > 0, `${context}: preserves orientation`)
  near(determinant, xScale * xScale, 1e-9)
  const scale = Math.sqrt(determinant)

  // Recompute the transform of sourceCenter by hand from a,b,c,d,e,f.
  near(matrix.a * sourceCenter.x + matrix.c * sourceCenter.y + matrix.e, projection.cx, 1e-9)
  near(matrix.b * sourceCenter.x + matrix.d * sourceCenter.y + matrix.f, projection.cy, 1e-9)

  // The original circle radius scales uniformly by the same factor.
  assert.ok(sourceCenter.radius > 0 && projection.radius > 0, `${context}: positive radii`)
  near(sourceCenter.radius * scale, projection.radius, 1e-9)

  // Every point of the source circle lands on the projected circle.
  for (const angle of [0, Math.PI / 3, Math.PI * 2 / 3, Math.PI, Math.PI * 4 / 3, Math.PI * 5 / 3]) {
    const x = sourceCenter.x + Math.cos(angle) * sourceCenter.radius
    const y = sourceCenter.y + Math.sin(angle) * sourceCenter.radius
    const mappedX = matrix.a * x + matrix.c * y + matrix.e
    const mappedY = matrix.b * x + matrix.d * y + matrix.f
    near(Math.hypot(mappedX - projection.cx, mappedY - projection.cy), projection.radius, 1e-9)
  }
  near(projection.apexY, projection.cy - projection.radius, 1e-9)
}

/** The transformed master rectangle has to stay full-bleed behind every scene. */
function assertMasterCovers(layout, width, height, context) {
  const { matrix, sourceWidth, sourceHeight } = layout
  const corners = [[0, 0], [sourceWidth, 0], [0, sourceHeight], [sourceWidth, sourceHeight]]
    .map(([x, y]) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f])
  const xs = corners.map(([x]) => x), ys = corners.map(([, y]) => y)
  assert.ok(Math.min(...xs) <= 1e-6 && Math.max(...xs) >= width - 1e-6, `${context}: covers viewport width`)
  assert.ok(Math.min(...ys) <= 1e-6 && Math.max(...ys) >= height - 1e-6, `${context}: covers viewport height`)
}

test('master circle maps through one affine transform in every target viewport', () => {
  for (const { label, width, height, mobile } of ALL_VIEWPORTS) {
    const layout = mediaSceneLayout(sceneCamera(), width, height, mobile)
    const narrow = width / height < .8
    assert.equal(layout.shape, narrow ? 'portrait' : 'landscape', label)
    assert.equal(layout.sourceWidth, narrow ? 2160 : 3840, label)
    assert.equal(layout.sourceHeight, narrow ? 3840 : 2160, label)
    assert.equal(layout.projection.width, width, label)
    assert.equal(layout.projection.height, height, label)
    assertAffineCircle(layout, label)
    assertMasterCovers(layout, width, height, label)
  }
})

test('media rotation follows the camera roll relative to the authored preset', () => {
  // The decoded master is authored with the panorama roll. Any camera roll is
  // expressed by rotating the master by the roll delta, never by shearing it.
  for (const roll of [PANORAMA.roll, 11, 4, -10]) {
    const layout = mediaSceneLayout(sceneCamera({ roll }), 1440, 900, false)
    const expected = (PANORAMA.roll - roll) * Math.PI / 180
    near(Math.atan2(layout.matrix.b, layout.matrix.a), expected, 1e-9)
    assertAffineCircle(layout, `roll ${roll}`)
  }
})

test('media crop is anchored on the live camera center at rest', () => {
  for (const view of [PANORAMA, INTERSTELLAR]) {
    for (const { label, width, height, mobile } of ALL_VIEWPORTS) {
      const camera = sceneCamera(view)
      const layout = mediaSceneLayout(camera, width, height, mobile)
      // Compose the same live camera HomeWorkspace/seam targets use: only the
      // mobile shell adds the responsive portrait camera offset before mapping
      // to CSS pixels; a narrow desktop window keeps the raw centerX.
      const liveCamera = {
        ...camera,
        centerX: camera.centerX + (mobile ? portraitCameraOffset(width, height, camera.zoom) : 0),
      }
      const live = sceneProjection(liveCamera, width, height)
      near(layout.projection.cx, live.cx, 1e-9)
      near(layout.projection.cy, live.cy, 1e-9)
    }
  }
})

test('a presented camera gives the entry target the projected center and shadow radius', () => {
  for (const view of [PANORAMA, INTERSTELLAR]) {
    for (const { label, width, height, mobile } of VIEWPORTS) {
      for (const mode of ['edge', 'center']) {
        for (const progress of [0, .4, 1]) {
          const camera = sceneCamera(view)
          const layout = mediaSceneLayout(camera, width, height, mobile, flightAt(progress, mode))
          const presented = { ...camera, presentation: layout.projection }
          const target = blackHoleEntryGeometry(presented, width, height)
          const context = `${label} · ${view === PANORAMA ? 'panorama' : 'interstellar'} · ${mode} p=${progress}`
          near(target.cx, layout.projection.cx, 1e-9)
          near(target.cy, layout.projection.cy, 1e-9)
          near(target.shadowRadius, layout.projection.radius, 1e-9)
          assert.ok(target.radius >= target.shadowRadius, `${context}: rim target contains the shadow`)
        }
      }
    }
  }
})

test('flight p=0, .4 and 1 keeps the map consistent and reverses identically', () => {
  for (const { label, width, height, mobile } of ALL_VIEWPORTS) {
    const camera = sceneCamera()
    const resting = mediaSceneLayout(camera, width, height, mobile)
    const forward = [0, .4, 1].map(progress => mediaSceneLayout(camera, width, height, mobile, flightAt(progress)))
    const reverse = [1, .4, 0].map(progress => mediaSceneLayout(camera, width, height, mobile, flightAt(progress)))
    for (const [index, layout] of forward.entries()) assertAffineCircle(layout, `${label} p=${[0, .4, 1][index]}`)

    assert.deepEqual(forward[1], reverse[1], `${label}: p=.4 is direction independent`)
    assert.deepEqual(forward[0], reverse[2], `${label}: p=0 is direction independent`)
    assert.deepEqual(forward[2], reverse[0], `${label}: p=1 is direction independent`)
    assert.deepEqual(forward[0], resting, `${label}: p=0 is the resting layout`)
    assert.deepEqual(
      mediaSceneLayout(camera, width, height, mobile, flightAt(0, 'center')),
      resting, `${label}: both modes rest at p=0`,
    )
    assert.notDeepEqual(forward[1], forward[0], `${label}: p=.4 actually moves the master`)
    assert.notDeepEqual(forward[2], forward[0], `${label}: p=1 actually moves the master`)

    // The centered flight trajectory is a different, equally consistent map.
    for (const [index, progress] of [.4, 1].entries()) {
      const centered = mediaSceneLayout(camera, width, height, mobile, flightAt(progress, 'center'))
      assertAffineCircle(centered, `${label} center p=${progress}`)
      assert.notDeepEqual(centered, forward[index + 1], `${label}: center and edge flights diverge at p=${progress}`)
    }
    // Caller-selected horizon framing must reach the layout.
    const customFrame = { height: .55, curvature: .2 }
    assert.notDeepEqual(
      mediaSceneLayout(camera, width, height, mobile, { progress: 1, mode: 'edge', edgeFrame: customFrame }),
      forward[2], `${label}: edgeFrame tuning changes the flight map`,
    )

    // Interleaved flight/viewport/preset samples cannot leak into the next result.
    mediaSceneLayout(sceneCamera(INTERSTELLAR), height, width, !mobile, flightAt(1, 'center'))
    assert.deepEqual(mediaSceneLayout(camera, width, height, mobile, flightAt(.4)), forward[1], label)
  }
})

test('edge flight p=1 lands the master on the documented horizon arc', () => {
  for (const frame of [{ height: .62, curvature: .16 }, { height: .55, curvature: .2 }]) {
    for (const { label, width, height, mobile } of ALL_VIEWPORTS) {
      const layout = mediaSceneLayout(sceneCamera(), width, height, mobile, { progress: 1, mode: 'edge', edgeFrame: frame })
      // Independent horizon editor relation: the visible arc spans the lower
      // viewport at height*frame.height with the same sagitta/radius geometry.
      const sag = width * frame.curvature
      const radius = Math.max((width * width / 4 + sag * sag) / (2 * sag), height * (1 - frame.height + .08))
      near(layout.projection.radius, radius, 1e-9)
      near(layout.projection.cx, width / 2, 1e-9)
      near(layout.projection.cy, height * frame.height + radius, 1e-9)
      // The banked flight camera turns the authored master by 3°.
      near(Math.atan2(layout.matrix.b, layout.matrix.a), 3 * Math.PI / 180, 1e-9)
      assertAffineCircle(layout, `${label} edge p=1`)
    }
  }
})

test('a full-viewport preview without safe-area insets keeps the live camera units', () => {
  // The authored 4K masters, the desktop design preview and a mobile browser
  // preview (data-mobile="preview", no native safe-area insets) all cover the
  // complete scene viewport, so presentation units must equal the live units.
  const previews = [
    { label: '3840x2160 landscape master', width: 3840, height: 2160, mobile: false, nativeMaster: true },
    { label: '2160x3840 portrait master', width: 2160, height: 3840, mobile: true, nativeMaster: true },
    { label: '1920x1080 design preview', width: 1920, height: 1080, mobile: false },
    { label: '1920x1200 design preview', width: 1920, height: 1200, mobile: false },
    { label: '1024x768 design preview', width: 1024, height: 768, mobile: false },
    { label: '390x844 preview without safe area', width: 390, height: 844, mobile: true },
    { label: '320x844 preview without safe area', width: 320, height: 844, mobile: true },
  ]
  for (const { label, width, height, mobile, nativeMaster } of previews) {
    const camera = sceneCamera()
    const layout = mediaSceneLayout(camera, width, height, mobile)
    const live = sceneProjection(camera, width, height)
    near(layout.projection.unit, live.unit, 1e-9)
    // A presentation that spans the full viewport is the geometry every scene
    // consumer sees, in the same CSS pixels the live renderer would report.
    const presented = sceneProjection({ ...camera, presentation: layout.projection }, width, height)
    near(presented.cx, layout.projection.cx, 1e-9)
    near(presented.cy, layout.projection.cy, 1e-9)
    near(presented.unit, layout.projection.unit, 1e-9)
    if (nativeMaster) {
      // A master rendered for this exact viewport must not be cropped at all.
      near(layout.matrix.a, 1, 1e-9)
      near(layout.matrix.d, 1, 1e-9)
      near(layout.matrix.b, 0, 1e-9)
      near(layout.matrix.c, 0, 1e-9)
      near(layout.matrix.e, 0, 1e-9)
      near(layout.matrix.f, 0, 1e-9)
    }
  }
})

test('a published presentation follows CSS viewport scaling until the next layout', () => {
  // sceneProjection scales the presentation with the viewport (CSS resizes that
  // happen before the media renderer recomputes), so scene UI stays attached.
  const camera = sceneCamera()
  const layout = mediaSceneLayout(camera, 1280, 720, false)
  for (const [scaleX, scaleY] of [[2, 2], [1.5, 1.5], [2, 1]]) {
    const width = Math.round(1280 * scaleX), height = Math.round(720 * scaleY)
    const scaled = sceneProjection({ ...camera, presentation: layout.projection }, width, height)
    near(scaled.cx, layout.projection.cx * width / 1280, 1e-9)
    near(scaled.cy, layout.projection.cy * height / 720, 1e-9)
    near(scaled.unit, layout.projection.unit * height / 720, 1e-9)
  }
})

test('transient response and handoff state never enters layout inputs or results', () => {
  const camera = sceneCamera()
  const reference = mediaSceneLayout(camera, 1440, 900, false)

  // Thinking/replying and handoff transitions only move camera-spring flags.
  const transient = sceneCamera({ cameraTransition: true, reducedMotion: true, paused: true, simulationTime: 812.25 })
  assert.deepEqual(mediaSceneLayout(transient, 1440, 900, false), reference)

  // An already-published media projection is an output, never a layout input.
  const stalePresentation = { width: 1280, height: 720, cx: 999, cy: 111, unit: 42 }
  assert.deepEqual(mediaSceneLayout(sceneCamera({ presentation: stalePresentation }), 1440, 900, false), reference)

  // Responsive samples for other viewports cannot leak into the next result.
  for (const { width, height, mobile } of VIEWPORTS) mediaSceneLayout(sceneCamera(INTERSTELLAR), width, height, mobile, flightAt(.6))
  assert.deepEqual(mediaSceneLayout(camera, 1440, 900, false), reference)

  // The camera and the flight description are inputs only.
  const cameraSnapshot = JSON.parse(JSON.stringify(camera))
  const flight = flightAt(.4)
  const flightSnapshot = JSON.parse(JSON.stringify(flight))
  mediaSceneLayout(camera, 1440, 900, false, flight)
  assert.deepEqual(camera, cameraSnapshot)
  assert.deepEqual(flight, flightSnapshot)
})

test('camera samples detect every presentation change', () => {
  const camera = sceneCamera()
  const projection = mediaSceneLayout(camera, 1440, 900, false).projection
  const presented = { ...camera, presentation: projection }
  assert.equal(sameCameraSample({ ...camera, presentation: { ...projection } }, presented), true)
  assert.equal(sameCameraSample(undefined, presented), false)
  assert.equal(sameCameraSample(camera, presented), false, 'entering media adds a presentation')
  assert.equal(sameCameraSample(presented, camera), false, 'leaving media removes a presentation')
  for (const [field, replacement] of [
    ['width', projection.width + 1], ['height', projection.height + 1],
    ['cx', projection.cx + .5], ['cy', projection.cy + .5], ['unit', projection.unit + .01],
  ]) {
    assert.equal(
      sameCameraSample(presented, { ...presented, presentation: { ...projection, [field]: replacement } }),
      false, `${field} change must republish scene geometry`,
    )
  }
  assert.equal(sameCameraSample(presented, { ...presented, cameraTransition: true }), false)
  assert.equal(sameCameraSample(presented, { ...presented, simulationTime: 512 }), true,
    'the ambient simulation clock alone is not a camera change')
})

test('media projection keeps camera.zoom as the business chat progress', () => {
  for (const { label, width, height, mobile } of VIEWPORTS) {
    const restCamera = sceneCamera()
    const zoomedCamera = sceneCamera({ zoom: INTERSTELLAR.zoom })
    const rest = mediaSceneLayout(restCamera, width, height, mobile)
    const zoomed = mediaSceneLayout(zoomedCamera, width, height, mobile)

    assert.equal(restCamera.zoom, PANORAMA.zoom, `${label}: layout never writes zoom back`)
    assert.equal(zoomedCamera.zoom, INTERSTELLAR.zoom, `${label}: layout never writes zoom back`)
    assert.equal('zoom' in rest.projection, false, `${label}: projection carries no business zoom`)
    // The media circle follows the camera zoom the chat progress is derived from.
    near(zoomed.projection.radius / rest.projection.radius, INTERSTELLAR.zoom / PANORAMA.zoom, 1e-12)
    near(zoomed.projection.unit / rest.projection.unit, INTERSTELLAR.zoom / PANORAMA.zoom, 1e-12)

    // Attaching the media projection cannot overwrite camera.zoom.
    const presented = { ...restCamera, presentation: rest.projection }
    const snapshot = { ...presented }
    sceneProjection(presented, width, height)
    assert.deepEqual(presented, snapshot)
    assert.equal(presented.zoom, PANORAMA.zoom)

    // Without a presentation the live geometry still derives from camera.zoom.
    assert.ok(sceneProjection(restCamera, width, height).unit !== sceneProjection(zoomedCamera, width, height).unit)
  }
  near(
    sceneProjection({ ...sceneCamera(), zoom: INTERSTELLAR.zoom }, 1280, 720).unit
      / sceneProjection(sceneCamera(), 1280, 720).unit,
    INTERSTELLAR.zoom / PANORAMA.zoom, 1e-12,
  )
})

test('independently rendered horizon master shares the panorama circle for the whole reversible dissolve', () => {
  for (const {width,height,mobile,label} of ALL_VIEWPORTS) for (const progress of [0,.2,.42,.55,.7,.85,.9,1]) {
    const layout=mediaSceneLayout(sceneCamera(),width,height,mobile,flightAt(progress))
    const m=layout.closeMatrix,s=layout.closeSourceCenter,p=layout.projection
    near(m.a*s.x+m.c*s.y+m.e,p.cx)
    near(m.b*s.x+m.d*s.y+m.f,p.cy)
    near(s.radius*Math.hypot(m.a,m.b),p.radius)
    assert.equal(layout.blend,mediaSceneLayout(sceneCamera(),width,height,mobile,flightAt(progress)).blend,label)
    assert.ok(layout.blend>=0&&layout.blend<=1)
  }
  for(const [width,height,mobile] of [[3840,2160,false],[2160,3840,true]]) {
    const {closeMatrix:m,blend}=mediaSceneLayout(sceneCamera(),width,height,mobile,flightAt(1))
    near(m.a,2);near(m.b,0);near(m.c,0);near(m.d,2);near(m.e,-width/2);near(m.f,-height/2)
    assert.equal(blend,1,'native close-up overscan is cropped about the same viewport, never enlarged from the panorama')
  }
})

test('the close-up master has no exposed rectangle edge once its dissolve begins',()=>{
 for(const {width,height,mobile,label} of VIEWPORTS)for(const progress of [.67,.7,.8,.9,1]){
  const l=mediaSceneLayout(sceneCamera(),width,height,mobile,flightAt(progress)),m=l.closeMatrix,det=m.a*m.d-m.b*m.c
  for(const[x,y]of[[0,0],[width,0],[width,height],[0,height]]){
   const sx=(m.d*(x-m.e)-m.c*(y-m.f))/det,sy=(-m.b*(x-m.e)+m.a*(y-m.f))/det
   assert.ok(sx>=-1e-6&&sx<=l.closeSourceWidth+1e-6&&sy>=-1e-6&&sy<=l.closeSourceHeight+1e-6,`${label} p=${progress}: inverse ${sx},${sy}`)
  }
 }
})

test('coverage uses the actual rotated rectangle, including viewport corners', () => {
  const turn = Math.PI / 4, a = Math.cos(turn), b = Math.sin(turn)
  const rotated = { a, b, c: -b, d: a, e: 50, f: 50 - 100 * a }
  // Its bounding box is 141px square, but all four viewport corners fall
  // outside the diamond: the former axis-aligned check accepted this case.
  assert.equal(mediaViewportCoverage(rotated, 100, 100, 100, 100), 0)
  assert.equal(mediaViewportCoverage({ a: 2, b: 0, c: 0, d: 2, e: -50, f: -50 }, 100, 100, 100, 100), 1)
})

test('a visible close-up never exposes an edge through enter, exit, resize or saved framing', () => {
  const viewports = [...ALL_VIEWPORTS,
    { label: 'reported desktop preview', width: 1086, height: 840, mobile: false },
    { label: 'landscape source breakpoint', width: 800, height: 1000, mobile: false },
  ]
  for (const { width, height, mobile, label } of viewports) for (const camera of [PANORAMA, INTERSTELLAR]) {
    for (const edgeFrame of [{ height: .62, curvature: .16 }, { height: .55, curvature: .2 }, { height: .86, curvature: .45 }]) {
      for (let step = 0; step <= 100; step++) {
        const progress = step / 100
        const layout = mediaSceneLayout(sceneCamera(camera), width, height, mobile, { progress, mode: 'edge', edgeFrame })
        assert.ok(layout.blend >= 0 && layout.blend <= 1, label)
        if (layout.blend === 0) continue
        const m = layout.closeMatrix, det = m.a * m.d - m.b * m.c
        for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
          const sx = (m.d * (x - m.e) - m.c * (y - m.f)) / det
          const sy = (-m.b * (x - m.e) + m.a * (y - m.f)) / det
          assert.ok(sx > 0 && sx < layout.closeSourceWidth && sy > 0 && sy < layout.closeSourceHeight, `${label} p=${progress}`)
        }
      }
    }
  }
  assert.equal(horizonMediaBlend(1), 1, 'completion is exact so the outgoing decoder can pause')
  assert.equal(horizonMediaBlend(0), 0)
  assert.equal(horizonMediaBlend(NaN), 0)
  for (const { width, height, mobile, label } of viewports) {
    const end = mediaSceneLayout(sceneCamera(), width, height, mobile, flightAt(1))
    assert.equal(end.blend, 1, `${label}: default framing fully reaches the close-up`)
  }
})
