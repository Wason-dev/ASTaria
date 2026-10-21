import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Regression tests for createHorizonPositionStyles, the helper that turns each
 * rendered horizon frame into inline styles for the mounted group buttons.
 *
 * The contract the studio depends on:
 *   1. after the first frame an unchanged frame submits no work at all: no
 *      queries, no inline assignments, no custom properties, even though every
 *      frame hands the helper new Map, point and projection objects, and even
 *      though the browser reads inline transforms back in its own serialization;
 *   2. positions, label width, caption anchor, tether, progress and browse keep
 *      the original geometry, including sub-pixel values;
 *   3. a lifted group dims only its neighbours, releasing restores them and an
 *      unknown held id dims nobody;
 *   4. positions that disappear hide their button, restore it and never write to
 *      an unloaded node;
 *   5. button refs register, re-register, replace and survive late cleanups;
 *   6. missing caption / tether children are safe and queried once;
 *   7. every dialog instance is initialised and a null dialog is safe.
 *
 * The DOM here is a counting fake: it records every query and every style write
 * and re-serializes inline styles the way CSSOM does, so an implementation that
 * compared against the element instead of its own submitted strings would be
 * caught by test 1.
 */

/** The app builds with bundler resolution; Node's type stripping needs the
 * extension, exactly as scripts/horizon-renderer.test.mjs resolves them. */
const hook = registerHooks({
  resolve(specifier, context, next) {
    return next(specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith('.ts')
      ? `${specifier}.ts` : specifier, context)
  },
})
const stylesUrl = new URL('../src/xixi/horizonPositionStyles.ts', import.meta.url).href
const sceneUrl = new URL('../src/xixi/horizonScene.ts', import.meta.url).href
const { createHorizonPositionStyles } = await import(stylesUrl)
const { horizonPoint, horizonProjection } = await import(sceneUrl)
hook.deregister()

/** Only the two fields horizonProjection reads from the appearance tuning. */
const TUNING = { height: .62, curvature: .16 }
const INLINE_PROPERTIES = ['visibility', 'transform', 'opacity', 'width', 'height']
/** The offsets the helper subtracts to place a group's hit box on its anchor. */
const BUTTON_OFFSET = { x: -40, y: -24 }

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))
const near = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should be ${expected}`)

/** CSSOM keeps `translate3d(1px,2px,0)` as `translate3d(1px, 2px, 0px)`. */
const serialize = (property, value) => property === 'transform'
  ? value.replace(/,/g, ', ').replace(/,\s*0\)$/, ', 0px)') : value

/** A counting stand-in for the few DOM surfaces the helper touches. */
function fakeDom() {
  const writes = [], customProperties = [], queries = []
  const element = (name, children = {}) => {
    const submitted = new Map(), readback = new Map(), attached = new Map()
    let node
    const style = {
      setProperty(property, value) {
        const text = String(value)
        customProperties.push({ node, property, value: text })
        submitted.set(property, text); readback.set(property, text)
      },
      getPropertyValue(property) { return readback.get(property) ?? '' },
      removeProperty(property) { submitted.delete(property); readback.delete(property); return '' },
    }
    for (const property of INLINE_PROPERTIES) Object.defineProperty(style, property, {
      enumerable: true, configurable: true,
      get() { return readback.get(property) ?? '' },
      set(value) {
        const text = String(value)
        writes.push({ node, property, value: text })
        submitted.set(property, text); readback.set(property, serialize(property, text))
      },
    })
    node = {
      name, style,
      querySelector(selector) { queries.push({ node, selector }); return attached.get(selector) ?? null },
      attach(selector, child) { attached.set(selector, child); return child },
      /** Test-side lookup that leaves the recorded query count alone. */
      child: selector => attached.get(selector) ?? null,
      submit: property => submitted.get(property) ?? '',
      resetStyle() { submitted.clear(); readback.clear() },
    }
    for (const [selector, child] of Object.entries(children)) node.attach(selector, child)
    return node
  }
  const button = (name, options = {}) => element(name, {
    ...(options.caption === false ? {} : { '.orbit-group-caption': element(`${name} caption`) }),
    ...(options.tether === false ? {} : { '.orbit-group-tether': element(`${name} tether`) }),
  })
  const mark = () => ({ writes: writes.length, customProperties: customProperties.length, queries: queries.length })
  return {
    element, button, writes, customProperties, queries, mark,
    since: mark => ({ writes: writes.slice(mark.writes), customProperties: customProperties.slice(mark.customProperties),
      queries: queries.slice(mark.queries) }),
    writesFor: node => writes.filter(write => write.node === node),
    customFor: node => customProperties.filter(entry => entry.node === node),
  }
}

const valuesFor = (dom, node) => Object.fromEntries(dom.writesFor(node).map(({ property, value }) => [property, value]))

function harness() {
  const dom = fakeDom(), buttons = new Map()
  return { dom, buttons, styles: createHorizonPositionStyles(buttons) }
}

/** A whole new Map of new point objects, as the renderer publishes each frame. */
const freshPositions = (projection, entries) => new Map(Object.entries(entries).map(([id, value]) => [id,
  typeof value === 'number' ? horizonPoint(projection, value) : { x: value.x, y: value.y }]))
/** A new projection object with the same numbers, as a frame would hand over. */
const sameProjection = projection => ({ ...projection })

/** 68% of the dialog width shared between the visible groups, clamped to 100-158px. */
const captionWidth = (projection, count) => clamp(projection.width * .68 / Math.max(1, count) - 18, 100, 158)
/** The caption is centred 76px above its group but never leaves the dialog. */
const captionAnchor = (projection, label, point) => ({
  x: clamp(point.x, label / 2 + 14, projection.width - label / 2 - 14), y: point.y - 76 })
/** 0 on top of the lifted strand, 1 once the group is clearly apart from it. */
const proximity = (point, held, label) => held
  ? Math.min(1, Math.hypot((point.x - held.x) / (label + 20), (point.y - held.y) / 70)) : 1
const ease = separation => .18 + .82 * separation * separation * (3 - 2 * separation)
/** Midway between apex and floor, never closer than 180px to the floor, on whole pixels. */
const browseValue = projection =>
  `${Math.round(Math.min((projection.apexY + projection.height) / 2, projection.height - 180))}px`
/** The widest band that fits: 540px, or the dialog minus its 24px insets. */
const progressEdge = projection => .5 - Math.min(540, projection.width - 48) / projection.width / 2
/** From 20px below the horizon limb down to 102px above the floor, clamped to 100-180px. */
const progressValue = projection => `${clamp(projection.height - 102
  - (horizonPoint(projection, progressEdge(projection)).y + 20), 100, 180)}px`

/** The full style set one frame owes a single button, derived from that frame. */
function expectedFor(projection, id, points, label, heldId) {
  const point = points.get(id), name = captionAnchor(projection, label, point)
  const held = heldId && heldId !== id ? points.get(heldId) : undefined
  const dx = name.x - point.x, dy = name.y - point.y + 29, span = Math.hypot(dx, dy)
  return {
    button: { visibility: 'visible', transform: `translate3d(${point.x + BUTTON_OFFSET.x}px,${point.y + BUTTON_OFFSET.y}px,0)` },
    caption: { opacity: String(ease(proximity(point, held, label))), width: `${label}px`,
      transform: `translate3d(${dx}px,${name.y - point.y}px,0) translateX(-50%)` },
    tether: { height: `${Math.max(0, span - 13)}px`, transform: `rotate(${-Math.atan2(dx, dy)}rad)` },
  }
}

const parseTranslate = value => {
  const match = /translate3d\(([^)]*)\)/.exec(value)
  assert.ok(match, `expected a translate3d in ${value}`)
  const parts = match[1].split(',').map(part => Number.parseFloat(part))
  assert.equal(parts.length, 3)
  return { x: parts[0], y: parts[1] }
}
const parseLength = value => {
  const match = /^(-?[\d.eE+]+)px$/.exec(value)
  assert.ok(match, `expected a px length in ${value}`)
  return Number(match[1])
}
const parseRotation = value => {
  const match = /^rotate\((-?[\d.eE+]+)rad\)$/.exec(value)
  assert.ok(match, `expected a rotate() in ${value}`)
  return Number(match[1])
}
/** CSS rotates a downward vector (0, length) to (-length·sin θ, length·cos θ). */
const tetherTip = (height, rotation) => ({ x: -height * Math.sin(rotation), y: height * Math.cos(rotation) })

/** Every value a button owes its frame, plus the geometry behind the numbers. */
function assertGeometry(dom, button, projection, label, points, id, heldId) {
  const expected = expectedFor(projection, id, points, label, heldId)
  assert.deepEqual(valuesFor(dom, button), expected.button, `${id} button`)
  assert.deepEqual(valuesFor(dom, button.child('.orbit-group-caption')), expected.caption, `${id} caption`)
  assert.deepEqual(valuesFor(dom, button.child('.orbit-group-tether')), expected.tether, `${id} tether`)
  const point = points.get(id), name = captionAnchor(projection, label, point)
  assert.ok(name.x >= label / 2 + 14 - 1e-9 && name.x <= projection.width - label / 2 - 14 + 1e-9,
    'names stay inside the dialog')
  assert.ok(expected.caption.transform.endsWith(' translateX(-50%)'), 'captions stay centred on their name')
  const translation = parseTranslate(expected.caption.transform)
  // The recorded translation is exactly the group-to-name displacement, so the
  // -50% centring puts the name over its clamped anchor 76px above the group.
  assert.equal(translation.x, name.x - point.x)
  assert.equal(translation.y, -76)
  const dx = name.x - point.x, dy = name.y - point.y + 29, span = Math.hypot(dx, dy)
  const tip = tetherTip(parseLength(expected.tether.height), parseRotation(expected.tether.transform))
  near(tip.x, dx * (span - 13) / span)
  near(tip.y, dy * (span - 13) / span)
  near(Math.hypot(tip.x, tip.y) + 13, span, 1e-9)
  assert.ok(tip.y < 0, 'the name sits above its group, so the tether points up')
}

test('1. repeated identical frames submit no queries, assignments or properties', () => {
  const { dom, styles } = harness()
  const dialog = dom.element('dialog')
  const nodes = ['a', 'b', 'c'].map(id => { const node = dom.button(id); styles.buttonRef(id)(node); return node })
  const projection = horizonProjection(1440, 900, TUNING)
  const frame = () => styles.update(dialog, freshPositions(projection, { a: .2, b: .5, c: .8 }), sameProjection(projection))

  frame()
  // One frame owes each button visibility + transform + three caption + two tether values.
  assert.equal(dom.writes.length, nodes.length * 7)
  assert.equal(dom.queries.length, nodes.length * 2, 'both children are queried once per mounted button')
  assert.deepEqual(dom.customProperties.map(entry => entry.property),
    ['--horizon-browse-y', '--horizon-progress-height'])
  // The element reads its transform back in the browser's own serialization, so
  // caching on the element instead of the submitted string would write forever.
  assert.notEqual(nodes[0].style.transform, nodes[0].submit('transform'))
  assert.equal(nodes[0].style.transform, serialize('transform', nodes[0].submit('transform')))

  const mark = dom.mark()
  for (let index = 0; index < 6; index++) frame()
  assert.deepEqual(dom.since(mark), { writes: [], customProperties: [], queries: [] },
    'new Map, point and projection objects with unchanged numbers must be free')
  assert.equal(dom.writes.length, nodes.length * 7)
})

test('2. transforms, label width, caption and tether keep the exact geometry', () => {
  const { dom, styles } = harness()
  const dialog = dom.element('dialog')
  const projection = horizonProjection(1440, 900, TUNING)
  const ids = ['near', 'mid', 'far']
  const nodes = Object.fromEntries(ids.map(id => [id, dom.button(id)]))
  for (const id of ids) styles.buttonRef(id)(nodes[id])
  const points = freshPositions(projection, { near: .18, mid: .5, far: .82 })

  // Three groups on a wide dialog: the label clamps at its 158px ceiling.
  styles.update(dialog, new Map(points), sameProjection(projection))
  assert.equal(captionWidth(projection, points.size), 158)
  for (const id of ids) assertGeometry(dom, nodes[id], projection, 158, points, id)

  // Seven groups (four still unmounted) move it into the arithmetic middle band.
  const seven = new Map([...points, ...['g4', 'g5', 'g6', 'g7'].map((id, index) =>
    [id, horizonPoint(projection, .3 + index * .1)])])
  const middle = captionWidth(projection, seven.size)
  assert.ok(middle > 100 && middle < 158, `${middle} must be an unclamped width`)
  styles.update(dialog, seven, sameProjection(projection))
  for (const id of ids) assertGeometry(dom, nodes[id], projection, middle, seven, id)
  assert.equal(dom.writes.some(write => ['g4', 'g5', 'g6', 'g7'].includes(write.node.name)), false,
    'positions without a mounted button are never written')

  // Twelve groups clamp the label at its 100px floor.
  const twelve = new Map([...seven, ...['g8', 'g9', 'g10', 'g11', 'g12'].map((id, index) =>
    [id, horizonPoint(projection, .1 + index * .05)])])
  styles.update(dialog, twelve, sameProjection(projection))
  assert.equal(captionWidth(projection, twelve.size), 100)
  for (const id of ids) assertGeometry(dom, nodes[id], projection, 100, twelve, id)

  // Frames arrive in new objects every time; a quarter pixel must not be rounded away.
  const nudged = Object.fromEntries(ids.map(id => [id,
    { x: points.get(id).x + .25, y: points.get(id).y - .125 }]))
  const moved = freshPositions(projection, nudged)
  styles.update(dialog, moved, sameProjection(projection))
  for (const id of ids) assertGeometry(dom, nodes[id], projection, 158, moved, id)
  const point = moved.get('mid'), transform = valuesFor(dom, nodes.mid).transform
  assert.ok(!Number.isInteger(point.x - 40) && !Number.isInteger(point.y - 24), 'pick a sub-pixel case')
  assert.equal(transform, `translate3d(${point.x - 40}px,${point.y - 24}px,0)`)
  assert.notEqual(transform, `translate3d(${Math.round(point.x - 40)}px,${Math.round(point.y - 24)}px,0)`)
  const translation = parseTranslate(transform)
  near(translation.x, point.x - 40, 1e-12)
  near(translation.y, point.y - 24, 1e-12)

  // A reshaped dialog updates label, caption, tether and progress in one frame.
  const phone = horizonProjection(390, 844, TUNING)
  const phonePoints = freshPositions(phone, { near: .18, mid: .5, far: .82 })
  styles.update(dialog, phonePoints, sameProjection(phone))
  const phoneLabel = captionWidth(phone, phonePoints.size)
  assert.equal(phoneLabel, 100, 'a phone dialog clamps the label at its floor, unlike the wide one')
  for (const id of ids) assertGeometry(dom, nodes[id], phone, phoneLabel, phonePoints, id)
  assert.equal(dom.customProperties.filter(entry => entry.property === '--horizon-progress-height').at(-1).value,
    progressValue(phone))
})

test('3. progress and browse follow the projection while browse stays on whole pixels', () => {
  const { dom, styles } = harness()
  const dialog = dom.element('dialog')
  const value = property => dom.customProperties.filter(entry => entry.property === property).at(-1)?.value
  const phone = horizonProjection(390, 844, TUNING)
  const next = freshPositions(phone, { a: .5 })
  styles.buttonRef('a')(dom.button('a'))

  // A phone dialog is between both clamps, so the band tracks quarter pixels.
  assert.ok(phone.width - 48 < 540, 'narrow dialogs inset the band by 24px')
  near(phone.width * progressEdge(phone), 24)
  styles.update(dialog, next, sameProjection(phone))
  const first = value('--horizon-progress-height')
  assert.equal(first, progressValue(phone))
  assert.ok(Number.parseFloat(first) > 100 && Number.parseFloat(first) < 180, 'the unclamped regime')
  near(Number.parseFloat(first) + 20 + 102 + horizonPoint(phone, progressEdge(phone)).y, phone.height)
  const nudged = { ...phone, apexY: phone.apexY + .25, cy: phone.cy + .25 }
  styles.update(dialog, next, sameProjection(nudged))
  assert.equal(value('--horizon-progress-height'), progressValue(nudged))
  assert.notEqual(progressValue(nudged), progressValue(phone), 'a quarter pixel still moves the band')
  near(Number.parseFloat(progressValue(nudged)), Number.parseFloat(progressValue(phone)) - .25, 1e-9)

  // Wide dialogs cap at 180px, short ones at 100px.
  assert.equal(progressValue(horizonProjection(1440, 900, TUNING)), '180px')
  assert.equal(progressValue(horizonProjection(1440, 400, TUNING)), '100px')

  // Browse keeps its whole-pixel line: it only rewrites when the rounded value moves.
  const shallow = { width: 1440, height: 900, apexY: 400, radius: 1240.2, cx: 720, cy: 1640.2 }
  styles.update(dialog, next, sameProjection(shallow))
  assert.equal(browseValue(shallow), '650px')
  assert.equal(value('--horizon-browse-y'), '650px')
  const mark = dom.mark()
  const eased = { ...shallow, apexY: 400.2, cy: 1640.4 }
  styles.update(dialog, next, sameProjection(eased))
  assert.equal(browseValue(eased), '650px')
  assert.deepEqual(dom.since(mark).customProperties, [], 'a fifth of a pixel stays on the same line')
  styles.update(dialog, next, { ...shallow, apexY: 401.2, cy: 1641.4 })
  assert.equal(value('--horizon-browse-y'), '651px', 'crossing the half pixel moves the line')
})

test('4. a lifted group dims only its neighbours and release restores them', () => {
  const { dom, styles } = harness()
  const dialog = dom.element('dialog')
  const projection = horizonProjection(390, 844, TUNING)
  const nodes = {}, captions = {}
  for (const id of ['a', 'b', 'c', 'd']) {
    nodes[id] = dom.button(id)
    captions[id] = nodes[id].child('.orbit-group-caption')
    styles.buttonRef(id)(nodes[id])
  }
  const spots = { a: { x: 120, y: 500 }, b: { x: 150, y: 505 }, c: { x: 360, y: 520 }, d: { x: 380, y: 530 } }
  const points = freshPositions(projection, spots)
  const label = captionWidth(projection, points.size)
  const lit = id => captions[id].submit('opacity')

  styles.update(dialog, new Map(points), sameProjection(projection))
  for (const id of Object.keys(nodes)) assert.equal(lit(id), '1')

  // Only heldId changes: the frame must not short circuit, and only the near
  // neighbour may be written.
  const mark = dom.mark()
  styles.update(dialog, new Map(points), sameProjection(projection), 'a')
  assert.deepEqual(dom.since(mark).writes.map(({ node, property, value }) => [node.name, property, value]),
    [['b caption', 'opacity', String(ease(proximity(spots.b, spots.a, label)))]])
  assert.equal(lit('a'), '1', 'the lifted name stays lit')
  for (const id of ['c', 'd']) assert.equal(lit(id), '1', 'distant names stay lit')

  // Releasing restores the neighbour without touching anything else.
  const released = dom.mark()
  styles.update(dialog, new Map(points), sameProjection(projection))
  assert.deepEqual(dom.since(released).writes.map(({ node, property }) => [node.name, property]),
    [['b caption', 'opacity']])
  for (const id of Object.keys(nodes)) assert.equal(lit(id), '1')

  // The lifted group keeps moving: the neighbour follows the new distance.
  const carried = { ...spots, a: { x: 145, y: 502 } }
  styles.update(dialog, freshPositions(projection, carried), sameProjection(projection), 'a')
  assert.equal(lit('b'), String(ease(proximity(spots.b, carried.a, label))))

  // An id that is no longer on the strand dims nobody, and repeats for free.
  styles.update(dialog, new Map(points), sameProjection(projection))
  const ghost = dom.mark()
  styles.update(dialog, new Map(points), sameProjection(projection), 'gone')
  assert.deepEqual(dom.since(ghost).writes, [], 'an unknown held id leaves every name lit')
  for (const id of Object.keys(nodes)) assert.equal(lit(id), '1')

  // Closer groups are dimmed more than distant ones.
  const ladder = { a: { x: 100, y: 500 }, b: { x: 130, y: 500 }, c: { x: 170, y: 500 }, d: { x: 320, y: 500 } }
  styles.update(dialog, freshPositions(projection, ladder), sameProjection(projection), 'a')
  const separations = ['b', 'c', 'd'].map(id => proximity(ladder[id], ladder.a, label))
  const opacities = ['b', 'c', 'd'].map(id => Number(lit(id)))
  for (let index = 1; index < separations.length; index++) {
    assert.ok(separations[index] > separations[index - 1], 'the ladder sorts by distance')
    assert.ok(opacities[index] > opacities[index - 1], 'further names stay brighter')
  }
  assert.ok(opacities[0] < 1 && opacities.at(-1) === 1)
})

test('5. removed groups hide, restore and never write to unloaded nodes', () => {
  const { dom, buttons, styles } = harness()
  const dialog = dom.element('dialog')
  const projection = horizonProjection(1440, 900, TUNING)
  const nodes = ['a', 'b', 'c'].map(id => { const node = dom.button(id); styles.buttonRef(id)(node); return node })
  const [a, b, c] = nodes
  const full = () => freshPositions(projection, { a: .2, b: .5, c: .8 })
  const withoutB = () => new Map([...full()].filter(([id]) => id !== 'b'))

  styles.update(dialog, full(), sameProjection(projection))

  // b leaves the page: only its own visibility changes, and only once.
  const hidden = dom.mark()
  styles.update(dialog, withoutB(), sameProjection(projection))
  assert.deepEqual(dom.since(hidden).writes.map(({ node, property, value }) => [node.name, property, value]),
    [['b', 'visibility', 'hidden']])
  const repeat = dom.mark()
  styles.update(dialog, withoutB(), sameProjection(projection))
  assert.deepEqual(dom.since(repeat).writes, [], 'a hidden frame with the same values writes nothing')

  // Coming back leaves the retained transform alone.
  const restored = dom.mark()
  styles.update(dialog, full(), sameProjection(projection))
  assert.deepEqual(dom.since(restored).writes.map(({ node, property, value }) => [node.name, property, value]),
    [['b', 'visibility', 'visible']])

  // A group that moved while hidden updates both values on return.
  styles.update(dialog, withoutB(), sameProjection(projection))
  const moved = freshPositions(projection, { a: .2, b: .62, c: .8 })
  const returned = dom.mark()
  styles.update(dialog, moved, sameProjection(projection))
  assert.deepEqual(dom.since(returned).writes.filter(write => write.node === b).map(({ property, value }) => [property, value]),
    [['visibility', 'visible'], ['transform', `translate3d(${moved.get('b').x - 40}px,${moved.get('b').y - 24}px,0)`]])

  // Unmounting b keeps its last values and stops every later write.
  const ref = styles.buttonRef('b')
  assert.equal(ref(null), undefined)
  assert.equal(buttons.has('b'), false)
  const frozen = dom.writesFor(b).length
  const afterNull = dom.mark()
  styles.update(dialog, freshPositions(projection, { a: .1, b: .6, c: .9 }), sameProjection(projection))
  assert.deepEqual(dom.since(afterNull).writes.filter(write => write.node === b), [])
  assert.equal(dom.writesFor(b).length, frozen, 'an unloaded node is never written again')
  assert.equal(a.submit('visibility'), 'visible')
  assert.equal(c.submit('visibility'), 'visible')
})

test('6. button refs re-register, replace and survive late cleanup', () => {
  const { dom, buttons, styles } = harness()
  const dialog = dom.element('dialog')
  const projection = horizonProjection(390, 844, TUNING)
  const spot = horizonPoint(projection, .5)
  const frame = (point = spot) => styles.update(dialog, freshPositions(projection, { group: point }), sameProjection(projection))

  const first = dom.button('group')
  const ref = styles.buttonRef('group')
  assert.equal(styles.buttonRef('group'), ref, 'the callback stays stable while its group is mounted')
  const firstCleanup = ref(first)
  assert.equal(typeof firstCleanup, 'function', 'React 19 receives the cleanup')
  frame()
  assert.equal(first.submit('visibility'), 'visible')
  const retired = new Set([first, first.child('.orbit-group-caption'), first.child('.orbit-group-tether')])

  // The same id renders as a new node: the replacement takes over.
  const second = dom.button('group-2')
  const secondCleanup = ref(second)
  assert.equal(typeof secondCleanup, 'function')
  const replaced = dom.mark()
  frame()
  assert.equal(buttons.get('group'), second)
  assert.equal(second.submit('visibility'), 'visible')
  assertGeometry(dom, second, projection, captionWidth(projection, 1), new Map([['group', spot]]), 'group')
  assert.equal(dom.since(replaced).writes.some(write => retired.has(write.node)), false,
    'neither the replaced button nor its cached children receive writes')
  const frozen = dom.writesFor(first).length

  // A late cleanup from the replaced mount must not detach its replacement.
  firstCleanup()
  assert.equal(buttons.get('group'), second)
  const late = dom.mark()
  frame()
  assert.deepEqual(dom.since(late).writes, [], 'the replacement keeps its cache')
  const carried = { x: spot.x + 12, y: spot.y - 6 }
  frame(carried)
  assert.equal(second.submit('transform'), `translate3d(${carried.x - 40}px,${carried.y - 24}px,0)`)
  assert.equal(dom.writesFor(first).length, frozen)

  // React 19 unmount calls that cleanup, and a remount re-registers the node
  // with a reset style: everything has to be re-queried and re-written.
  secondCleanup()
  assert.equal(buttons.has('group'), false)
  second.resetStyle()
  const retiredChildren = new Set([second.child('.orbit-group-caption'), second.child('.orbit-group-tether')])
  second.attach('.orbit-group-caption', dom.element('remounted caption'))
  second.attach('.orbit-group-tether', dom.element('remounted tether'))
  const detached = dom.mark()
  frame()
  assert.deepEqual(dom.since(detached).writes, [], 'a detached node is not written')
  assert.equal(second.submit('visibility'), '')
  const remount = styles.buttonRef('group')
  assert.equal(typeof remount(second), 'function')
  const remounted = dom.mark()
  frame()
  assert.deepEqual(dom.since(remounted).queries.filter(entry => entry.node === second).map(entry => entry.selector),
    ['.orbit-group-caption', '.orbit-group-tether'], 'a remounted button re-queries its children')
  assert.equal(second.submit('visibility'), 'visible')
  assert.equal(second.submit('transform'), `translate3d(${spot.x - 40}px,${spot.y - 24}px,0)`)
  assertGeometry(dom, second, projection, captionWidth(projection, 1), new Map([['group', spot]]), 'group')
  assert.equal(dom.since(remounted).writes.some(write => retiredChildren.has(write.node)), false,
    'remount resolves the new children and releases the old child references')

  // A null ref unregisters, unloads and stays safe when repeated.
  const solo = dom.button('solo')
  const soloRef = styles.buttonRef('solo')
  soloRef(solo)
  styles.update(dialog, freshPositions(projection, { solo: { x: 100, y: 300 } }), sameProjection(projection))
  assert.equal(solo.submit('visibility'), 'visible')
  soloRef(null)
  soloRef(null)
  assert.equal(buttons.has('solo'), false)
  const unloaded = dom.mark()
  styles.update(dialog, freshPositions(projection, { solo: { x: 120, y: 320 } }), sameProjection(projection))
  assert.deepEqual(dom.since(unloaded).writes, [])
})

test('7. missing caption and tether stay safe and are queried once', () => {
  const { dom, styles } = harness()
  const dialog = dom.element('dialog')
  const projection = horizonProjection(1440, 900, TUNING)
  const bare = dom.button('bare', { caption: false, tether: false })
  const half = dom.button('half', { tether: false })
  styles.buttonRef('bare')(bare)
  styles.buttonRef('half')(half)
  const frame = () => styles.update(dialog, freshPositions(projection, { bare: .35, half: .65 }), sameProjection(projection))

  frame()
  assert.equal(dom.queries.length, 4, 'both children are still queried once per button')
  const barePoint = horizonPoint(projection, .35), halfPoint = horizonPoint(projection, .65)
  assert.deepEqual(valuesFor(dom, bare), { visibility: 'visible',
    transform: `translate3d(${barePoint.x - 40}px,${barePoint.y - 24}px,0)` })
  assert.deepEqual(valuesFor(dom, half), { visibility: 'visible',
    transform: `translate3d(${halfPoint.x - 40}px,${halfPoint.y - 24}px,0)` })
  assert.deepEqual(Object.keys(valuesFor(dom, half.child('.orbit-group-caption'))).sort(),
    ['opacity', 'transform', 'width'], 'a caption without a tether still gets its values')
  assert.equal(half.child('.orbit-group-tether'), null)
  assert.equal(dom.writes.some(write => write.node.name === 'bare caption'), false)

  const mark = dom.mark()
  frame()
  assert.deepEqual(dom.since(mark), { writes: [], customProperties: [], queries: [] },
    'absent children are remembered as absent, not re-queried')

  // A caption-less button is still fully positioned while earlier groups leave.
  const late = dom.button('late', { caption: false })
  styles.buttonRef('late')(late)
  styles.update(dialog, freshPositions(projection, { late: .5 }), sameProjection(projection))
  const latePoint = horizonPoint(projection, .5)
  assert.deepEqual(valuesFor(dom, late), { visibility: 'visible',
    transform: `translate3d(${latePoint.x - 40}px,${latePoint.y - 24}px,0)` })
})

test('8. every dialog instance initialises, and a null dialog is safe', () => {
  const { dom, styles } = harness()
  const projection = horizonProjection(1440, 900, TUNING)
  const node = dom.button('a')
  styles.buttonRef('a')(node)
  const frame = dialog => styles.update(dialog, freshPositions(projection, { a: .5 }), sameProjection(projection))
  const expected = [['--horizon-browse-y', browseValue(projection)],
    ['--horizon-progress-height', progressValue(projection)]]

  const first = dom.element('dialog')
  frame(first)
  assert.deepEqual(dom.customFor(first).map(entry => [entry.property, entry.value]), expected)
  const repeat = dom.mark()
  frame(first)
  assert.deepEqual(dom.since(repeat).customProperties, [], 'an unchanged frame rewrites no property')

  const second = dom.element('dialog')
  frame(second)
  assert.deepEqual(dom.customFor(second).map(entry => [entry.property, entry.value]), expected,
    'a new dialog instance is initialised on its first frame')

  assert.doesNotThrow(() => frame(null))
  assert.equal(dom.customFor(first).length, 2)
  const moved = dom.mark()
  const away = horizonPoint(projection, .4)
  styles.update(null, freshPositions(projection, { a: .4 }), sameProjection(projection))
  assert.deepEqual(dom.since(moved).writes.map(({ node: target, property, value }) => [target.name, property, value]),
    [['a', 'transform', `translate3d(${away.x - 40}px,${away.y - 24}px,0)`]],
    'buttons keep updating without a dialog')
  assert.deepEqual(dom.since(moved).customProperties, [])
  // A clamped name still moves its caption and tether with no dialog in reach.
  styles.update(null, freshPositions(projection, { a: { x: 5, y: 300 } }), sameProjection(projection))
  assert.equal(node.child('.orbit-group-caption').submit('transform'), 'translate3d(88px,-76px,0) translateX(-50%)')
  assert.equal(node.child('.orbit-group-tether').submit('height'), `${Math.hypot(88, -47) - 13}px`)
})

test('9. a viewport and page-size matrix stays inside every documented band', () => {
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 900], [2560, 1080]]) {
    for (const count of [1, 2, 3, 5, 7, 9, 12]) {
      const { dom, styles } = harness()
      const dialog = dom.element('dialog')
      const projection = horizonProjection(width, height, TUNING)
      const slots = [...Array(count).keys()].map(index => .04 + .92 * (index + .5) / count)
      const points = new Map(slots.map((t, index) => [`g${index}`, horizonPoint(projection, t)]))
      const nodes = [...Array(Math.min(count, 5)).keys()].map(index => {
        const node = dom.button(`g${index}`)
        return { id: `g${index}`, node, caption: node.child('.orbit-group-caption') }
      })
      for (const { id, node } of nodes) styles.buttonRef(id)(node)
      styles.update(dialog, points, sameProjection(projection))

      const label = captionWidth(projection, count)
      assert.ok(label >= 100 && label <= 158, `${label} at ${width}x${height} with ${count} groups`)
      const progress = progressValue(projection)
      assert.equal(dom.customProperties.find(entry => entry.property === '--horizon-browse-y').value, browseValue(projection))
      assert.equal(dom.customProperties.find(entry => entry.property === '--horizon-progress-height').value, progress)
      assert.ok(Number.parseFloat(progress) >= 100 && Number.parseFloat(progress) <= 180)
      for (const { id, node, caption } of nodes) {
        assertGeometry(dom, node, projection, label, points, id)
        assert.equal(caption.submit('width'), `${label}px`)
        const point = points.get(id)
        assert.ok(point.x > 0 && point.x < width)
        assert.ok(point.y > projection.apexY - 1 && point.y < height)
      }
    }
  }
})
