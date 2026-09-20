import { spawn } from 'node:child_process'
import { mkdir, stat, chmod, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

function run(file, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const chunks = []
    let bytes = 0
    const timeout = setTimeout(() => { child.kill(); reject(new Error('钥匙串访问超时，请稍后重试')) }, 45_000)
    child.stdout.on('data', value => { bytes += value.length; if (bytes < 16_384) chunks.push(value); else child.kill() })
    child.stderr.resume() // OS messages must never become API responses or logs.
    child.on('error', () => { clearTimeout(timeout); reject(new Error('无法启动 macOS 钥匙串助手')) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error('钥匙串操作未完成，请检查系统授权'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export function createKeychain(dataDirectory) {
  let preparation
  const binary = join(dataDirectory, 'bin', 'astaria-keychain')
  const source = fileURLToPath(new URL('./native/keychain.m', import.meta.url))
  const prepare = () => preparation ??= (async () => {
    if (process.platform !== 'darwin') throw new Error('当前密钥存储支持 macOS 钥匙串')
    await mkdir(join(dataDirectory, 'bin'), { recursive: true, mode: 0o700 })
    const compiled = await stat(binary).catch(() => null)
    if (!compiled || compiled.mtimeMs < (await stat(source)).mtimeMs) {
      const temporary = `${binary}.${randomUUID()}`
      try {
        await run('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security', source, '-O2', '-o', temporary])
        await chmod(temporary, 0o700)
        await rename(temporary, binary)
      } finally { await rm(temporary, { force: true }) }
    }
  })().catch(error => { preparation = undefined; throw error })
  const invoke = async request => {
    await prepare()
    const result = JSON.parse(await run(binary, [], JSON.stringify(request)))
    if (!result.ok) throw new Error('钥匙串暂时不可用，请解锁或允许 ASTaria 访问')
    return result
  }
  return {
    prepare,
    status: async () => Boolean((await invoke({ action: 'status' })).configured),
    save: async key => {
      if (typeof key !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(key.trim())) throw new Error('请输入有效的 API Key')
      await invoke({ action: 'save', key: key.trim() })
    },
    read: async () => (await invoke({ action: 'get' })).key,
    remove: async () => { await invoke({ action: 'remove' }) },
  }
}
