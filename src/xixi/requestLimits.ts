import { BACKUP_IMPORT_REQUEST_MAX_BYTES, BACKUP_IMPORT_TOO_LARGE } from './backupLimits.ts'

// Explicit wire-body cap, independent of decoded attachment limits. Base64,
// JSON escaping and metadata can push a valid document over this cap; reject
// the complete request rather than truncating its original bytes or text.
export const CHAT_REQUEST_MAX_BYTES = 32 * 1024 * 1024
export function localRequestLimit(path: string): { bytes: number; message: string } {
  const endpoint = path.split('?')[0]
  if (endpoint === '/api/data/import') return { bytes: BACKUP_IMPORT_REQUEST_MAX_BYTES, message: BACKUP_IMPORT_TOO_LARGE }
  if (endpoint === '/api/chat') return { bytes: CHAT_REQUEST_MAX_BYTES, message: '聊天内容过多，请减少文字或重新选择附件' }
  if (endpoint === '/api/planner/import/recognize') return { bytes: 28 * 1024 * 1024, message: '课表原图与拆分图片合计过大，请缩小截取范围' }
  return { bytes: 4 * 1024 * 1024, message: '一次提交的内容过多' }
}
