/** Explicit disposable workspace only. Transfer shared/ and fixture-key.txt, never local/. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createFolderSync } from '../desktop/folderSync.mjs'

const [role, workspace] = process.argv.slice(2)
if (!['seed', 'respond', 'verify'].includes(role) || !workspace || !isAbsolute(workspace)) throw new Error('Use seed|respond|verify and an absolute disposable workspace')
await mkdir(workspace, { recursive: true })
const owner = join(workspace, 'ASTARIA-SYNC-TEST-ONLY')
if (role === 'seed') await writeFile(owner, 'Disposable synthetic data', { flag: 'wx' })
else assert.equal(await readFile(owner, 'utf8'), 'Disposable synthetic data')
const local = join(workspace, 'local'), shared = join(workspace, 'shared')
await mkdir(local, { recursive: true }); await mkdir(shared, { recursive: true })
const db = createDatabase(join(local, 'test.sqlite'))
const secrets = { available: () => true, read: () => key, write: (_name, value) => { key = value }, remove: () => { key = null } }
let key = role === 'seed' ? null : (await readFile(join(workspace, 'fixture-key.txt'), 'utf8')).trim()
const sync = createFolderSync({ store: db.sync, secrets, dataDirectory: local })
try {
  db.listAreas(); db.getPlanner()
  if (role === 'seed') {
    const task = db.createTask({ title: '跨设备验收：中文事项', notes: 'Mac seed', due: '2026-12-31' })
    db.updatePlanner({ type: 'set-day-exception', date: '2026-10-10', kind: 'holiday' }, db.getPlanner().revision)
    await sync.configure({ mode: 'shared', create: true, directory: shared })
    await writeFile(join(workspace, 'fixture-key.txt'), key, { mode: 0o600, flag: 'wx' })
    await writeFile(join(workspace, 'fixture.json'), JSON.stringify({ taskId: task.id }))
  } else {
    if (role === 'respond') await sync.configure({ mode: 'shared', create: false, directory: shared, joinKey: key })
    await sync.run()
    const { taskId } = JSON.parse(await readFile(join(workspace, 'fixture.json'), 'utf8'))
    assert.equal(db.sync.pending().length, 0, JSON.stringify(sync.status()))
    assert.equal(db.getTask(taskId)?.title, '跨设备验收：中文事项')
    assert.equal(db.getPlanner().dayExceptions['2026-10-10'].kind, 'holiday')
    if (role === 'respond') {
      db.updateTask(taskId, { notes: 'Windows 已接收并修改', status: 'done' })
      await sync.run()
    } else {
      assert.equal(db.getTask(taskId).notes, 'Windows 已接收并修改')
      assert.equal(db.getTask(taskId).status, 'done')
    }
  }
  const result = { passed: true, role, platform: process.platform, pending: db.sync.pending().length, outbox: db.sync.outbox().length, checkedAt: new Date().toISOString() }
  assert.equal(result.pending, 0); assert.equal(result.outbox, 0)
  await writeFile(join(workspace, `${role}-result.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { await sync.close(); db.close() }
