import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { chatCameraProgress, chatInteractionPhase } from '../src/home/chatMotion.ts'

// Exercise the shipped hook's RAF and publication decisions with a hook host.
const reactHost = 'data:text/javascript,' + encodeURIComponent(`
  export const useRef = value => ({ current: value });
  export const useEffect = effect => { globalThis.__astariaCameraTest.cleanup = effect(); };
  export const useState = initial => {
    const host = globalThis.__astariaCameraTest;
    host.state = initial;
    return [initial, update => {
      const next = update(host.state);
      if (next !== host.state) host.commits.push(next);
      host.state = next;
    }];
  };
`)
const root = new URL('../src/', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react' && context.parentURL === new URL('../src/spatial/useSceneCamera.ts', import.meta.url).href)
    return { url: reactHost, shortCircuit: true }
  return next(context.parentURL?.startsWith(root) && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { useSceneCamera } = await import('../src/spatial/useSceneCamera.ts')
hooks.deregister()

const camera = (zoom, transition = true) => ({ zoom, roll: 18, inclination: 83, centerX: .65, centerY: .51,
  cameraTransition: transition, reducedMotion: false, paused: false, simulationTime: 0 })

function mount(t, { imperative = true, keyed = true } = {}) {
  const frames = new Map(), commits = [], samples = []
  const document = Object.assign(new EventTarget(), { hidden: false })
  const window = new EventTarget(), motion = new EventTarget()
  let nextFrame = 0, current = camera(.7)
  const host = { commits }
  const descriptors = new Map()
  for (const [name, value] of Object.entries({ document, window, matchMedia: () => motion,
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id), __astariaCameraTest: host })) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  useSceneCamera(() => current, 'home:true', imperative ? value => samples.push(value) : undefined, keyed ? chatInteractionPhase : undefined)
  t.after(() => {
    host.cleanup()
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  return { commits, samples, document, window, host, get pending() { return frames.size },
    tick(value) {
      current = value
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(0)
    } }
}

test('chat becomes interactive at the existing 99% threshold before the camera settles', t => {
  const h = mount(t)
  h.tick(camera(.7))
  h.tick(camera(.8))
  const count = h.commits.length
  for (const zoom of [.9, 1, 1.4, 1.9, 2.03]) h.tick(camera(zoom))
  assert.equal(h.commits.length, count, 'no per-frame React commits inside a phase')
  h.tick(camera(2.04))
  assert.equal(chatInteractionPhase(h.host.state), 2)
  assert.equal(h.host.state.cameraTransition, true, 'input can unlock while the spring tail is still running')
  assert.equal(h.commits.length, count + 1)
  h.tick(camera(2.045))
  assert.equal(h.commits.length, count + 1)
  h.tick(camera(2.05, false))
  assert.equal(h.host.state.cameraTransition, false)
  assert.equal(h.pending, 0, 'settled camera stops polling')
})

test('a reversal publishes both input disabling and the collapsed focus boundary', t => {
  const h = mount(t)
  h.tick(camera(2.05))
  h.tick(camera(2))
  assert.equal(chatInteractionPhase(h.host.state), 1)
  h.tick(camera(1))
  h.tick(camera(.71))
  assert.equal(chatInteractionPhase(h.host.state), 0)
  assert.equal(h.host.state.cameraTransition, true)
  assert.equal(h.commits.length, 3)
})

test('duplicate geometry and clock-only samples do not repeat imperative updates', t => {
  const h = mount(t)
  h.tick(camera(.8))
  h.tick({ ...camera(.8), simulationTime: 10 })
  assert.equal(h.samples.length, 1)
  assert.equal(h.commits.length, 1)
})

test('visibility refresh and cleanup retain the existing background lifecycle', t => {
  const h = mount(t)
  h.tick(camera(1))
  h.document.hidden = true
  h.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(h.pending, 0)
  h.tick(camera(2.04))
  assert.equal(h.commits.length, 1)
  h.document.hidden = false
  h.document.dispatchEvent(new Event('visibilitychange'))
  h.tick(camera(2.04))
  assert.equal(chatInteractionPhase(h.host.state), 2)
  h.host.cleanup()
  h.window.dispatchEvent(new Event('focus'))
  assert.equal(h.pending, 0)
})

test('legacy consumers keep continuous React publication', t => {
  const continuous = mount(t, { imperative: false })
  continuous.tick(camera(.8)); continuous.tick(camera(1)); continuous.tick(camera(2.04))
  assert.equal(continuous.commits.length, 3)
})

test('legacy imperative consumers keep boundary-only React publication', t => {
  const boundary = mount(t, { keyed: false })
  boundary.tick(camera(.8)); boundary.tick(camera(1)); boundary.tick(camera(2.04))
  assert.equal(boundary.commits.length, 1)
  assert.equal(boundary.samples.length, 3)
})

test('progress keeps the original clamped camera mapping and reduced-motion endpoints', () => {
  assert.equal(chatCameraProgress(camera(.7, false)), 0)
  assert.equal(chatCameraProgress(camera(2.05, false)), 1)
  assert.equal(chatCameraProgress(camera(.55)), 0)
  assert.equal(chatCameraProgress(camera(2.2)), 1)
  assert.equal(chatInteractionPhase({ ...camera(2.05, false), reducedMotion: true }), 2)
})
