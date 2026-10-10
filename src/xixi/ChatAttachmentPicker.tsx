import { useRef } from 'react'
import type { ChatAttachment } from './types'
import { CHAT_IMAGE_ACCEPT, chatImageSize, readChatImage } from './chatAttachments'

type Props = {
  attachment: ChatAttachment | null
  onChange: (attachment: ChatAttachment | null) => void
  error?: string
  onError: (message: string) => void
  disabled?: boolean
  id: string
}

export function ChatAttachmentPicker({ attachment, onChange, error, onError, disabled = false, id }: Props) {
  const input = useRef<HTMLInputElement>(null)
  return <div className="xixi-attachment-picker">
    <input ref={input} className="p0-sr-only" id={id} type="file" accept={CHAT_IMAGE_ACCEPT} disabled={disabled} onChange={async event => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (!file) return
      try { onChange(await readChatImage(file)); onError('') }
      catch (reason) { onError(reason instanceof Error ? reason.message : '图片读取失败，请重新选择') }
    }} />
    {!attachment && <button type="button" className="xixi-attachment-button" disabled={disabled} onClick={() => input.current?.click()} aria-label="上传图片供析熙识别">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3" width="11" height="10" rx="2" /><circle cx="6" cy="6.5" r="1" /><path d="m3.5 11 3-3 2.2 2 1.5-1.4 2.3 2.4" /></svg><span>图片</span>
    </button>}
    {attachment && <div className="xixi-attachment-chip">
      <img src={attachment.data} alt="已选择的图片预览" />
      <span title={attachment.name}>{attachment.name} · {chatImageSize(attachment.size)}</span>
      <button type="button" className="xixi-attachment-remove" disabled={disabled} onClick={() => onChange(null)} aria-label="移除图片">×</button>
    </div>}
    {error && <p className="xixi-attachment-error" role="alert">{error}</p>}
  </div>
}

