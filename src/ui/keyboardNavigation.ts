/**
 * Show the existing rounded keyboard focus mode only after an intentional focus
 * move: direction keys and Tab/Shift+Tab. Text keys and pointer input clear it.
 */
export function observeKeyboardNavigation(doc: Document = document) {
  const set = (enabled: boolean) => { doc.documentElement.dataset.focusNavigation = enabled ? 'arrows' : 'pointer' }
  const navigationKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']
  const key = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    const editing = target?.matches?.('input,textarea,select,[contenteditable]:not([contenteditable=false])')
      || target?.closest?.('[contenteditable]:not([contenteditable=false])')
    // Arrow keys inside a text field move the caret, but Tab always moves the
    // focus (also out of a text field), so it keeps the focus ring visible.
    const navigation = navigationKeys.includes(event.key) && (event.key === 'Tab' || !editing)
    set(navigation && !event.isComposing && !event.ctrlKey && !event.metaKey)
  }
  const pointer = () => set(false)
  const capture = { capture: true }
  set(false)
  doc.addEventListener('keydown', key, capture)
  doc.addEventListener('pointerdown', pointer, capture)
  return () => { doc.removeEventListener('keydown', key, capture); doc.removeEventListener('pointerdown', pointer, capture) }
}
