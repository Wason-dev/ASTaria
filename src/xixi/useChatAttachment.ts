import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachment } from './types'
import { readChatAttachment } from './chatAttachments'

/** File selection and dropping share validation and latest-read ownership. */
export function useChatAttachment(disabled: boolean) {
  const [attachment, updateAttachment] = useState<ChatAttachment | null>(null)
  const [error, setError] = useState('')
  const [reading, setReading] = useState(false)
  const [readingLabel, setReadingLabel] = useState('正在读取附件…')
  const reader = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const generation = useRef(0)
  const blocked = useRef(disabled)
  blocked.current = disabled
  useEffect(() => () => { generation.current++; pending.current = false; reader.current?.abort() }, [])
  const setAttachment = useCallback((value: ChatAttachment | null) => {
    generation.current++
    reader.current?.abort(); reader.current = null
    pending.current = false
    setReading(false)
    updateAttachment(value)
    setError('')
  }, [])
  const selectFiles = useCallback(async (files: File[]) => {
    if (blocked.current) { setError('请等当前消息处理完，再添加附件'); return }
    const request = ++generation.current
    reader.current?.abort(); reader.current = new AbortController()
    pending.current = false
    setReading(false)
    // A replacement attempt owns the slot, even when the new file is invalid.
    // Otherwise Send can silently include the previous attachment after a failed drop.
    updateAttachment(null)
    if (files.length !== 1) { reader.current = null; setError('每条消息可添加一份附件，请一次选择一个文件'); return }
    pending.current = true
    setReading(true)
    setReadingLabel('正在读取附件…')
    setError('')
    try {
      const next = await readChatAttachment(files[0], { signal: reader.current.signal, onProgress: title => { if (request === generation.current) setReadingLabel(title) } })
      if (request !== generation.current) return
      if (blocked.current) { setError('当前消息正在处理，请稍后重新添加附件'); return }
      updateAttachment(next)
    } catch (reason) {
      if (request === generation.current) setError(reason instanceof Error ? reason.message : '附件读取失败，请重新选择')
    } finally {
      if (request === generation.current) { reader.current = null; pending.current = false; setReading(false) }
    }
  }, [])
  return { attachment, setAttachment, error, reading, readingLabel, selectFiles, isReading: () => pending.current }
}
