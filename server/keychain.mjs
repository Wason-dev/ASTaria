import { spawn } from 'node:child_process'
import { lstat, mkdtemp, chmod, readFile, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

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

export function createKeychain(_dataDirectory, { binaryPath, binarySha256 } = {}) {
  let preparation
  let binary = binaryPath, expectedHash = binarySha256
  const source = fileURLToPath(new URL('./native/keychain.m', import.meta.url))
  const prepare = () => preparation ??= (async () => {
    if (process.platform !== 'darwin') throw new Error('当前密钥存储支持 macOS 钥匙串')
    // Desktop builds ship a signed helper; end users do not need clang/Xcode.
    if (binaryPath) {
      const bundled = await lstat(binary)
      if (!bundled.isFile() || bundled.isSymbolicLink() || !(bundled.mode & 0o111)
        || !/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) throw new Error('应用内钥匙串助手不可用，请重新安装 ASTaria')
      return
    }
    // Source development still needs clang, but never executes a persistent,
    // replaceable cache from the user's data directory. Compile into a fresh
    // private directory and retain its digest in this process only.
    const directory = await mkdtemp(join(tmpdir(), 'astaria-keychain-'))
    try {
      binary = join(directory, 'astaria-keychain')
      await run('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security', source, '-O2', '-o', binary])
      await chmod(binary, 0o700)
      expectedHash = createHash('sha256').update(await readFile(binary)).digest('hex')
      process.once('exit', () => { try { rmSync(directory, { recursive: true, force: true }) } catch { /* OS temporary directory. */ } })
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  })().catch(error => { preparation = undefined; throw error })
  const invoke = async request => {
    await prepare()
    const info = await lstat(binary)
    if (!info.isFile() || info.isSymbolicLink() || createHash('sha256').update(await readFile(binary)).digest('hex') !== expectedHash) throw new Error('钥匙串助手校验失败，请重新打开或重新安装 ASTaria')
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
