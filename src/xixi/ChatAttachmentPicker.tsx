import { useRef } from 'react'
import type { ChatAttachment } from './types'
import { CHAT_ATTACHMENT_ACCEPT, chatImageSize } from './chatAttachments'
import { documentSummary, isDocumentAttachment } from './documentAttachment'

/** The only upload entry is beside Send; the textarea keeps its own geometry. */
export function ChatAttachmentPicker({ onFiles, disabled = false, id }: { onFiles: (files: File[]) => void; disabled?: boolean; id: string }) {
  const input = useRef<HTMLInputElement>(null)
  return <>
    <input ref={input} hidden id={id} type="file" accept={CHAT_ATTACHMENT_ACCEPT} disabled={disabled} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? [])
      event.currentTarget.value = ''
      if (files.length) onFiles(files)
    }} />
    <button type="button" className="xixi-attachment-button" disabled={disabled} onClick={() => input.current?.click()} aria-label="添加附件" title="添加图片、PDF、Word 或表格">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
    </button>
  </>
}

export function ChatAttachmentPreview({ attachment, error, reading, readingLabel = '正在读取附件…', onRemove, disabled = false }: { attachment: ChatAttachment | null; error: string; reading: boolean; readingLabel?: string; onRemove: () => void; disabled?: boolean }) {
  if (!attachment && !error && !reading) return null
  return <div className="xixi-attachment-preview" aria-busy={reading}>
    {attachment && <div className="xixi-attachment-chip">
      {isDocumentAttachment(attachment) ? <svg className="xixi-document-icon" viewBox="0 0 20 24" aria-hidden="true"><path d="M4 1h8l5 5v17H2V1h2m8 0v6h5M6 12h7m-7 4h7" /></svg> : <img src={attachment.data} alt="已选择的图片预览" />}
      <span title={attachment.name}>{attachment.name} · {isDocumentAttachment(attachment) ? documentSummary(attachment) : chatImageSize(attachment.size)}</span>
      <button type="button" className="xixi-attachment-remove" disabled={disabled} onClick={onRemove} aria-label={isDocumentAttachment(attachment) ? '移除文档' : '移除图片'}>×</button>
    </div>}
    {reading && <span role="status">{readingLabel}</span>}
    {reading && <button type="button" className="xixi-text-button" onClick={onRemove}>取消</button>}
    {attachment && isDocumentAttachment(attachment) && <small className="xixi-document-note">发送后交给当前模型读取{attachment.document.warnings.length ? ` · ${attachment.document.warnings.join('；')}` : ''}</small>}
    {error && <p className="xixi-attachment-error" role="alert">{error}</p>}
  </div>
}
