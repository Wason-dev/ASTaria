import { ValidationError } from './validation.mjs'

export const MAX_CHAT_ATTACHMENTS = 1
export const MAX_CHAT_IMAGE_BYTES = 2 * 1024 * 1024
export const CHAT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const fail = message => { throw new ValidationError(message) }

function decodedSize(encoded) {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) fail('图片内容不是有效的 Base64 数据')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) fail('图片内容不是有效的 Base64 数据')
  return bytes.length
}

/**
 * Images stay attached to the local conversation transcript. They are not
 * part of the business sync snapshot, API key settings, or tool arguments.
 */
export function normalizeChatAttachments(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) fail('每条消息最多附带一张图片')
  if (!value.length) return undefined
  const attachments = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('图片附件格式不正确')
    const keys = Object.keys(item)
    if (keys.some(key => !['name', 'mime', 'size', 'data'].includes(key))) fail('图片附件包含不支持的字段')
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '图片'
    if (name.length > 160 || /[\u0000-\u001f\u007f]/u.test(name)) fail('图片文件名不正确')
    if (typeof item.mime !== 'string' || !CHAT_IMAGE_TYPES.has(item.mime)) fail('仅支持 PNG、JPEG 或 WebP 图片')
    if (typeof item.data !== 'string' || !item.data.startsWith(`data:${item.mime};base64,`)) fail('图片附件内容不正确')
    const encoded = item.data.slice(`data:${item.mime};base64,`.length)
    const actualSize = decodedSize(encoded)
    if (actualSize < 1 || actualSize > MAX_CHAT_IMAGE_BYTES) fail('图片大小不能超过 2 MB')
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size !== actualSize)) fail('图片附件大小不一致')
    return { name, mime: item.mime, size: actualSize, data: item.data }
  })
  return attachments
}

export function providerImageContent(attachments) {
  return (attachments ?? []).map(attachment => ({ type: 'image_url', image_url: { url: attachment.data } }))
}
