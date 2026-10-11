import { useRef } from 'react'
import type { ChatAttachment } from './types'
import { CHAT_IMAGE_ACCEPT, chatImageSize } from './chatAttachments'

/** The only upload entry is beside Send; the textarea keeps its own geometry. */
export function ChatAttachmentPicker({ onFiles, disabled = false, id }: { onFiles: (files: File[]) => void; disabled?: boolean; id: string }) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} hidden id={id} type="file" accept={CHAT_IMAGE_ACCEPT} disabled={disabled} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''
      if (files.length) onFiles(files)
    }} />
    <button type="button" className="xixi-attachment-button" disabled={disabled} onClick={() => input.current?.click()} aria-label="添加图片" title="添加图片">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
    </button>
  </>
}

export function ChatAttachmentPreview({ attachment, error, reading, onRemove, disabled = false }: { attachment: ChatAttachment | null; error: string; reading: boolean; onRemove: () => void; disabled?: boolean }) {
  if (!attachment && !error && !reading) return null
  return <div className="xixi-attachment-preview" aria-busy={reading}>
    {attachment && <div className="xixi-attachment-chip">
      <img src={attachment.data} alt="已选择的图片预览" />
      <span title={attachment.name}>{attachment.name} · {chatImageSize(attachment.size)}</span>
      <button type="button" className="xixi-attachment-remove" disabled={disabled} onClick={onRemove} aria-label="移除图片">×</button>
    </div>}
    {reading && <span role="status">正在读取图片…</span>}
    {error && <p className="xixi-attachment-error" role="alert">{error}</p>}
  </div>
}
