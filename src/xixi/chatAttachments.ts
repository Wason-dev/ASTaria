import type { ChatAttachment, ChatImageAttachment } from './types'
import { CHAT_DOCUMENT_ACCEPT, assertDocumentSize, documentFormat, projectDocumentAttachment } from './documentAttachment.ts'
import { assertChatImageDimensions, assertChatImageSize, inspectChatImage } from './chatImagePolicy.ts'
import type { ChatImageDimensions } from './chatImagePolicy.ts'

export { CHAT_IMAGE_ACCEPT, CHAT_IMAGE_MAX_BYTES } from './chatImagePolicy.ts'
export const CHAT_ATTACHMENT_ACCEPT = `image/png,image/jpeg,image/webp,${CHAT_DOCUMENT_ACCEPT}`

type ImageDecoder = (blob: Blob) => Promise<ChatImageDimensions>

async function decodeBrowserImage(blob: Blob): Promise<ChatImageDimensions> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    try { return { width: bitmap.width, height: bitmap.height } }
    finally { bitmap.close() }
  }
  const image = new Image(), url = URL.createObjectURL(blob)
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('图片无法解码'))
      image.src = url
    })
    // onload can fire after reading a header, before corrupt pixels are decoded.
    if (typeof image.decode === 'function') await image.decode()
    return { width: image.naturalWidth, height: image.naturalHeight }
  } finally {
    image.onload = image.onerror = null
    image.src = ''
    URL.revokeObjectURL(url)
  }
}

/** Preserve the original bytes; the decoder is injectable for DOM-free tests. */
export async function readChatImage(file: File, { decodeImage = decodeBrowserImage }: { decodeImage?: ImageDecoder } = {}): Promise<ChatImageAttachment> {
  assertChatImageSize(file.size)
  let buffer: ArrayBuffer
  try { buffer = await file.arrayBuffer() }
  catch { throw new Error('图片读取失败，请重新选择') }
  const bytes = new Uint8Array(buffer), info = inspectChatImage(bytes)
  if (bytes.byteLength !== file.size) throw new Error('图片附件大小不一致')
  let decoded: ChatImageDimensions
  try { decoded = await decodeImage(new Blob([buffer], { type: info.mime })) }
  catch { throw new Error('图片内容已损坏或无法解码，请重新选择') }
  assertChatImageDimensions(decoded)
  // EXIF orientation can transpose the browser's decoded width and height.
  if (!((decoded.width === info.width && decoded.height === info.height) || (decoded.width === info.height && decoded.height === info.width))) {
    throw new Error('图片解码尺寸与文件内容不一致，请重新选择')
  }
  let data: string
  if (typeof FileReader !== 'undefined') {
    data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败，请重新选择'))
      reader.onerror = reader.onabort = () => reject(new Error('图片读取失败，请重新选择'))
      reader.readAsDataURL(new Blob([buffer], { type: info.mime }))
    })
  } else {
    // Non-DOM test hosts retain the same original byte representation.
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    data = `data:${info.mime};base64,${btoa(binary)}`
  }
  return { name: file.name.slice(0, 160) || '图片', mime: info.mime, size: bytes.byteLength, data }
}

export function readChatAttachment(file: File, { signal, onProgress = () => {} }: { signal?: AbortSignal; onProgress?: (title: string) => void } = {}): Promise<ChatAttachment> {
  if (!documentFormat(file.name) && !file.name.toLowerCase().endsWith('.doc')) return readChatImage(file)
  assertDocumentSize(file.size)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('已取消读取文档')); return }
    const worker = new Worker(new URL('./documentReader.worker.ts', import.meta.url), { type: 'module' })
    let stopped = false
    const stop = () => { stopped = true; worker.terminate(); signal?.removeEventListener('abort', abort); worker.onmessage = worker.onerror = worker.onmessageerror = null }
    const abort = () => { stop(); reject(new Error('已取消读取文档')) }
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = event => {
      if (stopped) return
      // PDF.js also emits its own worker initialization packets. Only our
      // parser's channel can own progress/completion of this attachment.
      if (event.data?.channel !== 'astaria-document-v1' || !['progress', 'done', 'error'].includes(event.data?.type)) return
      if (event.data?.type === 'progress') { onProgress(event.data.title); return }
      stop()
      if (event.data?.type === 'done') {
        try { resolve(projectDocumentAttachment(event.data.attachment)) }
        catch (error) { reject(error) }
      }
      else reject(new Error(event.data?.message || '文档读取失败，请重新选择'))
    }
    worker.onerror = () => { stop(); reject(new Error('文档读取失败，请重新选择')) }
    worker.onmessageerror = () => { stop(); reject(new Error('文档读取结果传输失败，请重新选择')) }
    try { worker.postMessage({ file }) }
    catch (error) { stop(); reject(error) }
  })
}

export function chatImageSize(size: number) {
  return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MiB` : `${Math.max(1, Math.round(size / 1024))} KiB`
}

