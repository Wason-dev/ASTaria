import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const geometryUrl = new URL('../src/home/blackHoleEntryGeometry.ts', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === geometryUrl && specifier === '../spatial/scene') return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
})
const { blackHoleEntryGeometry } = await import(geometryUrl)
hook.deregister()

test('homepage click target follows the rendered horizon in desktop, portrait, and resized viewports', () => {
  const camera = { zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51 }
  for (const [width, height] of [[1440, 900], [390, 844], [900, 900], [2048, 768]]) {
    const geometry = blackHoleEntryGeometry(camera, width, height)
    const narrow = width / height < .8
    const center = narrow ? [.5 + (camera.centerX - .5) * .2, .5 + (camera.centerY - .5) * 6]
      : [camera.centerX, camera.centerY]
    assert.equal(geometry.cx, center[0] * width)
    assert.equal(geometry.cy, (1 - center[1]) * height)
    // Trace screen-space points through the GPU's pinhole camera equation.
    // Every point on the visual limb must map to the critical impact parameter.
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.7]) {
      const x = geometry.cx + Math.cos(angle) * geometry.shadowRadius
      const y = geometry.cy + Math.sin(angle) * geometry.shadowRadius
      const scale = (narrow ? 13.8 : 10.2) / camera.zoom
      const px = (x / width - center[0]) * width / height * scale
      const py = (1 - y / height - center[1]) * scale
      const transverse = Math.hypot(px, py)
      const impact = 30 * transverse / Math.hypot(30, transverse) / Math.sqrt(1 - 1 / 30)
      assert.ok(Math.abs(impact - Math.sqrt(27) / 2) < 1e-10)
    }
    assert.ok(geometry.radius > geometry.shadowRadius, 'the glowing rim belongs to the target')
    assert.ok(geometry.radius < geometry.shadowRadius * 1.05, 'do not capture the surrounding sky')
  }
})
