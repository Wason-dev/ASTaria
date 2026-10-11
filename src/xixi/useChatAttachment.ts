import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachment } from './types'
import { readChatImage } from './chatAttachments'

/** File selection and dropping share validation and latest-read ownership. */
export function useChatAttachment(disabled: boolean) {
  const [attachment, updateAttachment] = useState<ChatAttachment | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const pending = useRef(false)
  const generation = useRef(0)
  const blocked = useRef(disabled)
  blocked.current = disabled
  useEffect(() => () => { generation.current++; pending.current = false }, [])
  const setAttachment = useCallback((value: ChatAttachment | null) => {
    generation.current++
    pending.current = false
    setReading(false)
    updateAttachment(value)
    setError('')
  }, [])
  const selectFiles = useCallback(async (files: File[]) => {
    if (blocked.current) { setError('请等当前消息处理完，再添加图片'); return }
    const request = ++generation.current
    pending.current = false
    setReading(false)
    // A replacement attempt owns the slot, even when the new file is invalid.
    // Otherwise Send can silently include the previous image after a failed drop.
    updateAttachment(null)
    if (files.length !== 1) { setError('每条消息可添加一张图片，请一次拖入一张'); return }
    pending.current = true
    setReading(true)
    setError('')
    try {
      const next = await readChatImage(files[0])
      if (request !== generation.current) return
      if (blocked.current) { setError('当前消息正在处理，请稍后重新添加图片'); return }
      updateAttachment(next)
    } catch (reason) {
      if (request === generation.current) setError(reason instanceof Error ? reason.message : '图片读取失败，请重新选择')
    } finally {
      if (request === generation.current) { pending.current = false; setReading(false) }
    }
  }, [])
  return { attachment, setAttachment, error, reading, selectFiles, isReading: () => pending.current }
}
