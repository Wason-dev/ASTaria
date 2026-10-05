import { lstat, mkdir, readdir, readFile, realpath, rename, unlink, open, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { encryptSyncOperation, decryptSyncOperation, syncRevision, MAX_OPERATION_BYTES } from '../server/syncProtocol.mjs'

const keyId = key => createHash('sha256').update(key).digest('hex')
const hex = value => /^[a-f0-9]{32}$/u.test(value)
const inside = (path, base) => { const rel = relative(base, path); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const filename = op => `${String(op.sequence).padStart(12, '0')}-${op.operationId}.op`

async function directory(path, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('同步目录无效或包含符号链接')
}
async function file(path, limit = MAX_OPERATION_BYTES * 2) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('同步文件无效或过大')
  const value = await readFile(path)
  if (value.length > limit) throw new Error('同步文件过大')
  return value
}
async function atomicWrite(path, bytes) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.partial`
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await rename(temp, path) } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

export function createFolderSync({ store, secrets, dataDirectory, selectDirectory, saveKey, onApplied = () => {} }) {
  let working, mutation, timer, mutating = false, stopped = false, message = store.config() ? '同步已配置，等待检查目录' : '尚未设置同步'
  const exclusive = action => async (...args) => {
    if (mutating || stopped) throw new Error('同步正在处理，请稍后重试')
    mutating = true
    mutation = (async () => { await working; return await action(...args) })()
    try { return await mutation } finally { mutating = false; mutation = null }
  }
  const readKey = () => {
    const value = secrets.read('sync-key')
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('同步密钥缺失，请在原设备导出后重新加入')
    return Buffer.from(value, 'hex')
  }
  async function rootFor(selected) {
    if (!isAbsolute(selected)) throw new Error('请选择完整的同步目录')
    const root = await realpath(selected), local = await realpath(dataDirectory)
    if (inside(root, local) || inside(local, root)) throw new Error('同步目录必须与 ASTaria 本机数据目录分开')
    await directory(root)
    await access(root, constants.R_OK | constants.W_OK)
    return root
  }
  async function marker(root) {
    await directory(join(root, '.astaria-sync'))
    const value = JSON.parse((await file(join(root, '.astaria-sync', 'group.json'), 2048)).toString('utf8'))
    if (value.schema !== 1 || !hex(value.groupId) || !/^[a-f0-9]{64}$/u.test(value.keyId)) throw new Error('同步目录版本或标识无效')
    return value
  }
  async function configure({ mode, joinKey, create = false, directory: selected }) {
    if (store.config()) throw new Error('请先断开当前同步组')
    if (!['shared', 'syncthing'].includes(mode)) throw new Error('请选择同步方式')
    if (!secrets.available()) throw new Error('当前系统凭据存储不可用')
    const chosen = selected ?? await selectDirectory()
    if (stopped) return status()
    if (!chosen) return status()
    const root = await rootFor(chosen)
    if (mode === 'syncthing') {
      try { await directory(join(root, '.stfolder')) } catch { throw new Error('未找到 Syncthing 共享目录标记，请先在 Syncthing 中共享此目录') }
    }
    let group, key
    if (create) {
      key = randomBytes(32)
      group = { schema: 1, groupId: randomBytes(16).toString('hex'), keyId: keyId(key) }
      // A group is immutable; a fresh directory is required for rotation/revocation.
      await mkdir(join(root, '.astaria-sync'), { mode: 0o700 })
      await atomicWrite(join(root, '.astaria-sync', 'group.json'), Buffer.from(JSON.stringify(group)))
    } else {
      if (typeof joinKey !== 'string' || !/^[a-f0-9]{64}$/u.test(joinKey.trim())) throw new Error('加入密钥应为 64 位十六进制字符')
      key = Buffer.from(joinKey.trim(), 'hex')
      group = await marker(root)
      if (keyId(key) !== group.keyId) throw new Error('加入密钥与此同步目录不匹配')
    }
    secrets.write('sync-key', key.toString('hex'))
    store.configure({ directory: root, mode, groupId: group.groupId })
    message = '同步已配置，正在检查目录'
    await run(true)
    return status()
  }
  async function scan() {
    const cfg = store.config()
    if (!cfg) { message = '尚未设置同步'; return }
    if (cfg.paused) { message = '同步已暂停，本机变更继续排队'; return }
    const key = readKey(), root = await rootFor(cfg.directory), group = await marker(root)
    if (cfg.mode === 'syncthing') await directory(join(root, '.stfolder'))
    if (group.groupId !== cfg.groupId || group.keyId !== keyId(key)) throw new Error('同步目录或密钥发生变化，请检查所选目录')
    const devices = join(root, '.astaria-sync', 'devices')
    await directory(devices, true)
    const own = join(devices, cfg.deviceId)
    await directory(own, true)
    const ownOps = join(own, 'operations')
    await directory(ownOps, true)
    for (const operation of store.outbox()) {
      const target = join(ownOps, filename(operation))
      try {
        const previous = decryptSyncOperation(await file(target), key)
        if (syncRevision(previous) !== syncRevision(operation)) throw new Error('已导出操作内容不匹配')
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await atomicWrite(target, encryptSyncOperation(operation, key))
      }
      store.exported(operation.operationId)
    }
    let count = 0, applied = false
    const issues = []
    for (const entry of (await readdir(devices)).sort()) {
      if (!hex(entry)) continue
      await directory(join(devices, entry))
      const operations = join(devices, entry, 'operations')
      try { await directory(operations) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      for (const name of (await readdir(operations)).sort()) {
        if (name.endsWith('.partial')) { issues.push('有文件尚未完整落地，稍后重试'); continue }
        if (!/^\d{12,16}-[a-f0-9]{32}\.op$/u.test(name)) { issues.push('有无法识别的文件，请检查同步工具的冲突副本'); continue }
        if (++count > 20000) throw new Error('同步文件超过单轮检查上限，请先暂停并联系维护者')
        try {
          const op = decryptSyncOperation(await file(join(operations, name)), key)
          if (op.deviceId !== entry || filename(op) !== name) throw new Error('文件名称与操作身份不一致')
          if (store.receive(op) === 'applied') applied = true
        } catch (error) { issues.push(`${entry.slice(0, 8)}/${name}：${error.message}`) }
      }
    }
    // A missing predecessor may have arrived after a previously queued file.
    for (const row of store.pending()) if (store.receive(JSON.parse(row.document)) === 'applied') applied = true
    if (applied) onApplied()
    if (issues.length) throw new Error(issues.slice(0, 5).join('；'))
    store.checked()
    message = store.status().conflicts.length ? '有待处理操作，请查看原因' : '本机目录已检查；其他设备送达取决于文件传输'
  }
  function run(internal = false) {
    if (stopped || mutating && !internal) return working ?? Promise.resolve()
    return working ??= scan().catch(error => { message = `同步未完成：${error.code === 'EACCES' || error.code === 'EPERM' ? '目录只读或权限不足' : error.code === 'ENOENT' ? '目录或文件暂未落地，请检查挂载与同步工具' : error.message}` }).finally(() => { working = null })
  }
  const status = () => ({ available: secrets.available(), ...store.status(), busy: Boolean(working) || mutating, message })
  return {
    status, configure: exclusive(configure), run,
    start: () => { timer = setInterval(() => { void run() }, 30000); timer.unref?.(); void run() },
    close: async () => { stopped = true; clearInterval(timer); await Promise.allSettled([working, mutation]) },
    pause: exclusive(async paused => { store.pause(paused); await run(true); return status() }),
    disconnect: exclusive(async () => { store.disconnect(); secrets.remove('sync-key'); message = '已断开，本机数据与共享目录保留'; return status() }),
    exportKey: exclusive(async () => {
      const cfg = store.config(); if (!cfg) throw new Error('尚未配置同步')
      await saveKey(readKey().toString('hex'), path => !inside(path, cfg.directory))
      return status()
    }),
    resolve: exclusive(async (operationId, choice) => {
      if (!['local', 'remote'].includes(choice)) throw new Error('请选择冲突处理方式')
      await working; store.resolve(operationId, choice); onApplied(); await run(true); return status()
    }),
  }
}

export async function handleSyncRequest(sync, req, res) {
  const path = req.url?.split('?')[0]
  if (!path?.startsWith('/api/sync/')) return false
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  try {
    let result
    if (req.method === 'GET' && path === '/api/sync/status') result = sync.status()
    else if (req.method === 'POST' && /^application\/json(?:;|$)/iu.test(req.headers['content-type'] ?? '')) {
      let size = 0; const chunks = []
      for await (const chunk of req) { if ((size += chunk.length) > 16384) throw new Error('同步请求过大'); chunks.push(chunk) }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      if (path === '/api/sync/configure') {
        if (!value || typeof value !== 'object' || Object.keys(value).some(k => !['mode', 'create', 'joinKey'].includes(k)) || typeof value.create !== 'boolean') throw new Error('同步配置无效')
        result = await sync.configure(value)
      } else if (path === '/api/sync/check') { await sync.run(); result = sync.status() }
      else if (path === '/api/sync/pause' && typeof value.paused === 'boolean') result = await sync.pause(value.paused)
      else if (path === '/api/sync/disconnect' && value.confirmed === true) result = await sync.disconnect()
      else if (path === '/api/sync/export-key') result = await sync.exportKey()
      else if (path === '/api/sync/resolve' && typeof value.operationId === 'string') result = await sync.resolve(value.operationId, value.choice)
      else throw new Error('同步操作无效')
    } else throw new Error('同步请求方式无效')
    res.end(JSON.stringify(result))
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })) }
  return true
}
