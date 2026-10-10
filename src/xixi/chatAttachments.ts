import type { ChatAttachment } from './types'

export const CHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'
export const CHAT_IMAGE_MAX_BYTES = 2 * 1024 * 1024

const imageTypes = new Set<ChatAttachment['mime']>(['image/png', 'image/jpeg', 'image/webp'])

export function readChatImage(file: File): Promise<ChatAttachment> {
  if (!imageTypes.has(file.type as ChatAttachment['mime'])) return Promise.reject(new Error('仅支持 PNG、JPEG 或 WebP 图片'))
  if (file.size > CHAT_IMAGE_MAX_BYTES) return Promise.reject(new Error('图片大小不能超过 2 MB'))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择'))
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.startsWith(`data:${file.type};base64,`)) {
        reject(new Error('图片内容无法读取，请重新选择'))
        return
      }
      resolve({ name: file.name.slice(0, 160) || '图片', mime: file.type as ChatAttachment['mime'], size: file.size, data: reader.result })
    }
    reader.readAsDataURL(file)
  })
}

export function chatImageSize(size: number) {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`
}

