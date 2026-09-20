import { useRef } from 'react'
import type { KeyboardEvent } from 'react'

/** Enter submits; IME confirmation (including WebKit's trailing Enter) does not. */
export function useChatSubmitKey(onSubmit: () => void) {
  const composing = useRef(false)
  const compositionEndedAt = useRef(-Infinity)
  return {
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false; compositionEndedAt.current = performance.now() },
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter' || event.shiftKey) return
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
      event.preventDefault()
      if (event.repeat || performance.now() - compositionEndedAt.current < 100) return
      onSubmit()
    },
  }
}
