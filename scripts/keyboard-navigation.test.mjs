import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { observeKeyboardNavigation } from '../src/ui/keyboardNavigation.ts'

function harness() {
  const doc = new EventTarget(); doc.documentElement = { dataset: {} }
  const stop = observeKeyboardNavigation(doc)
  const key = (name, extra = {}, target) => {
    const event = new Event('keydown'); Object.assign(event, { key: name, ...extra })
    if (target) Object.defineProperty(event, 'target', { value: target })
    doc.dispatchEvent(event)
  }
  return { doc, key, mode: () => doc.documentElement.dataset.focusNavigation, stop }
}

test('direction keys and Tab/Shift+Tab activate the visible focus mode', () => {
  const { key, mode } = harness()
  assert.equal(mode(), 'pointer', 'mouse-first start keeps the focus ring hidden')
  for (const arrow of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) { key(arrow); assert.equal(mode(), 'arrows') }
  key('Tab'); assert.equal(mode(), 'arrows', 'Tab is keyboard navigation, not a cancel')
  key('Tab', { shiftKey: true }); assert.equal(mode(), 'arrows', 'Shift+Tab is keyboard navigation too')
})

test('letters, other keys, composition, modifiers and pointer input still cancel', () => {
  const { doc, key, mode, stop } = harness()
  for (const letter of ['w', 'a', 's', 'd', 'Enter', 'Escape']) {
    key('Tab'); assert.equal(mode(), 'arrows')
    key(letter); assert.equal(mode(), 'pointer')
  }
  key('Tab'); key('Tab', { isComposing: true }); assert.equal(mode(), 'pointer')
  key('Tab'); key('Tab', { ctrlKey: true }); assert.equal(mode(), 'pointer')
  key('Tab'); key('Tab', { metaKey: true }); assert.equal(mode(), 'pointer')
  key('ArrowLeft'); doc.dispatchEvent(new Event('pointerdown')); assert.equal(mode(), 'pointer')
  stop(); key('Tab'); assert.equal(mode(), 'pointer', 'disposing stops listening')
})

test('arrow keys in editing targets stay off, Tab still gets the focus ring', () => {
  const { key, mode } = harness()
  const input = { matches: () => true, closest: () => null }
  key('ArrowUp', {}, input); assert.equal(mode(), 'pointer')
  key('Tab', {}, input); assert.equal(mode(), 'arrows')
  const editable = { matches: () => false, closest: () => true }
  key('ArrowDown', {}, editable); assert.equal(mode(), 'pointer')
  key('Tab', {}, editable); assert.equal(mode(), 'arrows')
})

test('navigation focus keeps using the existing keyboard-navigation.css rounded focus shape', async () => {
  const css = await readFile(new URL('../src/ui/keyboard-navigation.css', import.meta.url), 'utf8')
  assert.ok(css.includes('html[data-focus-navigation=arrows] .p0'), 'the mode the module toggles is the one the stylesheet styles')
  assert.ok(css.includes('html:not([data-focus-navigation=arrows]) .p0'), 'pointer mode keeps hiding the generic focus shape')
})
