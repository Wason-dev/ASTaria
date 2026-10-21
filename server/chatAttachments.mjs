import { ValidationError } from './validation.mjs'
import { decodeBase64, encodeBase64 } from './portable.mjs'
import { CHAT_IMAGE_ACCEPT, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_BASE64_LENGTH, assertChatImageSize, inspectChatImage } from '../src/xixi/chatImagePolicy.ts'
import { normalizeChatDocument } from './chatDocuments.mjs'

export const MAX_CHAT_ATTACHMENTS = 1
export const MAX_CHAT_IMAGE_BYTES = CHAT_IMAGE_MAX_BYTES
export const CHAT_IMAGE_TYPES = new Set(CHAT_IMAGE_ACCEPT.split(','))

const fail = message => { throw new ValidationError(message) }

function imageBytes(encoded) {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) fail('图片内容不是有效的 Base64 数据')
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  try { assertChatImageSize(encoded.length / 4 * 3 - padding) }
  catch (error) { fail(error.message) }
  let bytes
  try { bytes = decodeBase64(encoded) }
  catch { fail('图片内容不是有效的 Base64 数据') }
  if (encodeBase64(bytes) !== encoded) fail('图片内容不是有效的 Base64 数据')
  return bytes
}

/**
 * Images stay attached to the local conversation transcript. They are not
 * part of the business sync snapshot, API key settings, or tool arguments.
 */
export function normalizeChatAttachments(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) fail('每条消息最多附带一张图片或一份文档')
  if (!value.length) return undefined
  const attachments = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('图片附件格式不正确')
    if (item.kind === 'document') return normalizeChatDocument(item)
    const keys = Object.keys(item)
    if (keys.some(key => !['name', 'mime', 'size', 'data'].includes(key))) fail('图片附件包含不支持的字段')
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '图片'
    if (name.length > 160 || /[\u0000-\u001f\u007f]/u.test(name)) fail('图片文件名不正确')
    if (typeof item.mime !== 'string' || !CHAT_IMAGE_TYPES.has(item.mime)) fail('仅支持 PNG、JPEG 或 WebP 图片')
    const prefix = `data:${item.mime};base64,`
    if (typeof item.data !== 'string') fail('图片附件内容不正确')
    // Bound the string before slicing or allocating decoded bytes.
    if (item.data.length > prefix.length + CHAT_IMAGE_MAX_BASE64_LENGTH) fail('图片大小不能超过 10 MiB')
    if (!item.data.startsWith(prefix)) fail('图片附件内容不正确')
    const bytes = imageBytes(item.data.slice(prefix.length)), actualSize = bytes.byteLength
    try { assertChatImageSize(actualSize) }
    catch (error) { fail(error.message) }
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size !== actualSize)) fail('图片附件大小不一致')
    let info
    try { info = inspectChatImage(bytes) }
    catch (error) { fail(error.message) }
    if (info.mime !== item.mime) fail('图片附件 MIME 与实际格式不一致')
    return { name, mime: item.mime, size: actualSize, data: item.data }
  })
  return attachments
}

export function providerImageContent(attachments) {
  return (attachments ?? []).filter(attachment => attachment.kind !== 'document' && CHAT_IMAGE_TYPES.has(attachment.mime))
    .map(attachment => ({ type: 'image_url', image_url: { url: attachment.data } }))
}
