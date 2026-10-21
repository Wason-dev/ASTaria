import { sha256Hex } from '../../server/portable.mjs'

export const MAX_MOBILE_DATABASE_BYTES = 64 * 1024 * 1024
export function checkedSnapshot(bytes, expectedHash) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 100 || bytes.length > MAX_MOBILE_DATABASE_BYTES
    || new TextDecoder().decode(bytes.subarray(0, 16)) !== 'SQLite format 3\0'
    || (expectedHash && sha256Hex(bytes) !== expectedHash)) throw new Error('本机数据校验失败，原数据已保留；请先恢复备份')
  return bytes
}

/** A save is acknowledged only after the durable store confirms its commit.
 * Serialize callers so the next save cannot overtake an earlier one. */
export function serialCalls() {
  let pending = Promise.resolve()
  return callback => {
    const next = pending.then(callback)
    pending = next.catch(() => {})
    return next
  }
}

export function indexedSnapshots({ indexedDB = globalThis.indexedDB, name = 'astaria-mobile-v1' } = {}) {
  let opening
  const open = () => opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('snapshot')
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); opening = undefined }
      resolve(request.result)
    }
    request.onerror = () => { opening = undefined; reject(new Error('本机存储无法打开，请检查可用空间')) }
    request.onblocked = () => { opening = undefined; reject(new Error('另一窗口正在使用本机存储，请关闭后重试')) }
  })
  const transact = async (mode, callback) => {
    const db = await open()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('snapshot', mode)
      let result
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = transaction.onabort = () => reject(new Error('本机数据未能保存，请检查存储空间；此次操作没有确认成功'))
      try { const request = callback(transaction.objectStore('snapshot')); request.onsuccess = () => { result = request.result } }
      catch (error) { transaction.abort(); reject(error) }
    })
  }
  return {
    async load() {
      const saved = await transact('readonly', store => store.get('current'))
      return saved ? checkedSnapshot(new Uint8Array(saved.bytes), saved.sha256) : undefined
    },
    async save(bytes) {
      checkedSnapshot(bytes)
      return transact('readwrite', store => store.put({ bytes, sha256: sha256Hex(bytes) }, 'current'))
    },
  }
}
