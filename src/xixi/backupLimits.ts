/** The limit applies to the exact UTF-8 JSON file offered for download. */
export const BACKUP_MAX_BYTES = 32 * 1024 * 1024
export const BACKUP_EXPORT_TOO_LARGE = '备份超过 32 MiB 上限，未生成可恢复的备份文件；本机数据未改动'
export const BACKUP_IMPORT_TOO_LARGE = '备份超过 32 MiB 上限，无法恢复；本机数据未改动'

export function backupByteLength(json: string): number {
  return new TextEncoder().encode(json).byteLength
}

export function serializeBackup(backup: unknown): string {
  const json = JSON.stringify(backup, null, 2)
  if (typeof json !== 'string') throw new Error('备份内容不是有效的 JSON')
  return json
}

// localApi sends compact JSON. Reserve its exact fixed wrapper outside the
// file budget so a file at the limit can still be restored through the API.
export const BACKUP_IMPORT_REQUEST_MAX_BYTES = BACKUP_MAX_BYTES
  + backupByteLength(JSON.stringify({ backup: null, confirmed: true })) - 'null'.length
