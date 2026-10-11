import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'

type Target = (files: File[]) => void
const DropTarget = createContext<MutableRefObject<Target | null> | null>(null)

/** Only the active workbench composer can override the home-chat fallback. */
export function useChatImageDropTarget(active: boolean, onFiles: Target) {
  const target = useContext(DropTarget)
  const latest = useRef(onFiles)
  latest.current = onFiles
  useEffect(() => {
    if (!active || !target) return
    const accept: Target = files => latest.current(files)
    target.current = accept
    return () => { if (target.current === accept) target.current = null }
  }, [active, target])
}

export function ChatImageDropProvider({ children, onFiles, blocked, onBlocked }: { children: ReactNode; onFiles: Target; blocked: boolean; onBlocked: () => void }) {
  const target = useRef<Target | null>(null)
  const latest = useRef({ onFiles, blocked, onBlocked })
  latest.current = { onFiles, blocked, onBlocked }
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const reset = () => { depth = 0; setDragging(false) }
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = latest.current.blocked ? 'none' : 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      // OS file drags can have a null relatedTarget even between child elements.
      if (--depth <= 0) reset()
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      // Cancel native navigation, including unsupported or oversized files.
      event.preventDefault()
      event.stopPropagation()
      reset()
      if (latest.current.blocked) { latest.current.onBlocked(); return }
      const files = Array.from(event.dataTransfer?.files ?? [])
      if (files.length) (target.current ?? latest.current.onFiles)(files)
    }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') reset() }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', reset)
    window.addEventListener('blur', reset)
    window.addEventListener('keydown', key)
    document.addEventListener('visibilitychange', reset)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', reset)
      window.removeEventListener('blur', reset)
      window.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', reset)
    }
  }, [])
  return <DropTarget.Provider value={target}>
    {children}
    {dragging && <div className="xixi-image-drop" role="status">{blocked ? '请先结束当前操作，再添加图片' : '松开，将图片添加到析熙的输入框'}</div>}
  </DropTarget.Provider>
}
