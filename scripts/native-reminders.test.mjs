import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('macOS 原生预约替换先撤销旧时间，即使新预约添加失败', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'astaria-native-reminders-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binary = join(directory, 'test-center')
  await promisify(execFile)('/usr/bin/clang', ['-fobjc-arc', '-framework', 'AppKit', '-framework', 'UserNotifications', '-framework', 'CoreServices',
    fileURLToPath(new URL('./fixtures/reminders-center.m', import.meta.url)), '-o', binary])
  const start = Math.floor(Date.now() / 1000) + 3600
  const old = { id: 'astaria.session', title: '即将开始：余时测试', body: '18:00–18:30 · 本次余时', at: start }
  const unrelated = { id: 'other-app', title: '其他提醒', body: '不受影响', at: start }
  const unchanged = { ...old, id: 'astaria.unchanged' }
  const run = (previous, desired, failIds = []) => new Promise((resolve, reject) => {
    const child = execFile(binary, [JSON.stringify({ previous, failIds })], { timeout: 10000 }, (error, stdout) => {
      if (error) return reject(error)
      try { const [result, queue] = stdout.trim().split('\n').map(line => JSON.parse(line)); resolve({ result, ...queue }) } catch (reason) { reject(reason) }
    })
    child.stdin.end(JSON.stringify(desired))
  })
  for (const id of [old.id, 'astaria.moved-to-next-day']) {
    const next = { ...old, id, body: '19:00–19:30 · 本次余时', at: start + 3600 }
    const success = await run([old, unchanged, unrelated], [next, unchanged])
    assert.equal(success.result.error, undefined)
    assert.deepEqual(success.entries.find(entry => entry.id === id), next)
    assert.ok(!success.entries.some(entry => entry.id === old.id && entry.at === old.at))
    assert.ok(success.calls.indexOf(`remove:${old.id}`) < success.calls.indexOf(`add:${id}`))
    const failed = await run([old, unchanged, unrelated], [next, unchanged], [id])
    assert.ok(failed.result.error)
    assert.deepEqual(failed.entries.map(entry => entry.id).sort(), [unchanged.id, unrelated.id].sort(), '新预约失败不能保留旧触发器')
    assert.ok(!failed.removed.includes(unchanged.id), '其他有效预约继续保留')
  }
  const removed = await run([old, unrelated], [])
  assert.deepEqual(removed.entries, [unrelated])
  const past = await run([old], [{ ...old, at: Math.floor(Date.now() / 1000) - 1 }])
  assert.deepEqual(past.entries, [], '新提醒时间已过时只取消旧预约，不补发')
})
