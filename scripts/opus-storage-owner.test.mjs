import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createDatabase } from '../server/database.mjs'

const moduleUrl = new URL('../server/database.mjs', import.meta.url).href
const input = { requestId: 'synthetic-owner', conversationId: 'main', text: 'synthetic', context: { timezone: 'UTC' } }
function location(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'opus-storage-owner-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, filename: join(directory, 'test.sqlite') }
}
function edit(filename, change) {
  const raw = new DatabaseSync(filename)
  try {
    const turn = JSON.parse(raw.prepare('SELECT document FROM turns WHERE id=?').get(input.requestId).document)
    change(turn)
    raw.prepare('UPDATE turns SET document=? WHERE id=?').run(JSON.stringify(turn), input.requestId)
  } finally { raw.close() }
}
async function child(t, filename, legacy = false) {
  const script = `import {createDatabase} from ${JSON.stringify(moduleUrl)};
    const db=createDatabase(process.argv[1]);
    db.beginTurn(${JSON.stringify(input)});
    ${legacy ? `const {DatabaseSync}=await import('node:sqlite');const raw=new DatabaseSync(process.argv[1]);
      const turn=JSON.parse(raw.prepare('SELECT document FROM turns WHERE id=?').get('synthetic-owner').document);
      turn.ownerToken='legacy-synthetic-owner';
      raw.prepare('UPDATE turns SET document=? WHERE id=?').run(JSON.stringify(turn),'synthetic-owner'); raw.close();` : ''}
    process.send({ready:true});
    process.on('message', message => {if(message==='finish'){db.finishTurn('synthetic-owner',{status:'completed'});process.send({finished:true})}});
    setInterval(()=>{},1000);`
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', script, filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''; processChild.stderr.on('data', data => { stderr += data })
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) { const exited = once(processChild, 'exit'); processChild.kill('SIGKILL'); await exited }
  })
  const ready = await Promise.race([
    once(processChild, 'message'),
    once(processChild, 'exit').then(() => { throw new Error(`child exited early: ${stderr}`) }),
  ])
  assert.equal(ready[0].ready, true)
  return processChild
}

test('new owner: another live process, ancient timestamps and stopped event loop remain owned', { timeout: 15000 }, async t => {
  const { filename, directory } = location(t), live = await child(t, filename)
  edit(filename, turn => { turn.createdAt = turn.updatedAt = '2000-01-01T00:00:00.000Z' })
  const observer = createDatabase(filename); t.after(() => observer.close())
  assert.equal(observer.getTurn(input.requestId).status, 'running')
  assert.equal(observer.beginTurn(input).claimed, false)
  assert.throws(() => observer.beginTurn({ ...input, requestId: 'other' }), error => error.status === 409)
  assert.throws(() => observer.updateTurnProgress(input.requestId, {}), error => error.status === 409)
  assert.throws(() => observer.finishTurn(input.requestId, { status: 'failed' }), error => error.status === 409)
  assert.throws(() => observer.exportData(), error => error.status === 409)
  if (process.platform !== 'win32') {
    const alias = join(directory, 'alias.sqlite'); symlinkSync(filename, alias)
    const peer = createDatabase(alias); assert.equal(peer.getTurn(input.requestId).status, 'running'); peer.close()
    live.kill('SIGSTOP')
    try { observer.recoverAbandonedTurns(); assert.equal(observer.getTurn(input.requestId).status, 'running') }
    finally { live.kill('SIGCONT') }
  }
  const finished = once(live, 'message'); live.send('finish'); assert.equal((await finished)[0].finished, true)
  assert.equal(observer.getTurn(input.requestId).status, 'completed')
  assert.equal(observer.exportData().format, 'astaria-backup')
})

test('new owner: abrupt exit and reused live PID recover without reopening, retry idempotent', { timeout: 15000 }, async t => {
  const { filename } = location(t), live = await child(t, filename)
  const observer = createDatabase(filename); t.after(() => observer.close())
  const exited = once(live, 'exit'); live.kill('SIGKILL'); await exited
  // Simulate PID reuse deterministically; the current test process is alive.
  edit(filename, turn => { turn.ownerPid = process.pid })
  const backup = observer.exportData()
  assert.equal(JSON.parse(backup.tables.turns[0].document).status, 'failed')
  assert.equal(observer.beginTurn(input).claimed, true)
  assert.equal(observer.listMessages('main').length, 1)
  observer.finishTurn(input.requestId, { status: 'completed' })
  assert.equal(observer.beginTurn(input).claimed, false)
})

test('legacy macOS PID 1 / unrelated live process cannot pin running forever', { skip: process.platform !== 'darwin' }, async t => {
  const { filename } = location(t)
  const seed = createDatabase(filename); seed.beginTurn(input); seed.close()
  const unrelated = spawn(process.execPath, ['-e', 'process.send({ready:true});setInterval(()=>{},1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  t.after(async () => { const exited = once(unrelated, 'exit'); unrelated.kill('SIGKILL'); await exited })
  await once(unrelated, 'message')
  for (const pid of [1, unrelated.pid]) {
    edit(filename, turn => { turn.status = 'running'; turn.ownerToken = 'legacy-unrelated'; turn.ownerPid = pid })
    const reopened = createDatabase(filename)
    try {
      assert.equal(reopened.getTurn(input.requestId).status, 'failed')
      assert.equal(reopened.exportData().format, 'astaria-backup')
    } finally { reopened.close() }
  }
})

test('legacy live service holding the DB is preserved, then recovered after exit', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const { filename } = location(t), live = await child(t, filename, true)
  const observer = createDatabase(filename); t.after(() => observer.close())
  assert.equal(observer.getTurn(input.requestId).status, 'running')
  assert.equal(observer.beginTurn(input).claimed, false)
  assert.throws(() => observer.exportData(), error => error.status === 409)
  const exited = once(live, 'exit'); live.kill('SIGKILL'); await exited
  observer.recoverAbandonedTurns()
  assert.equal(observer.getTurn(input.requestId).status, 'failed')
})

test('legacy EPERM is unknown, never sufficient to fail a potentially active owner', { timeout: 15000 }, async t => {
  const { filename } = location(t), live = await child(t, filename, true)
  const kill = process.kill
  let observer
  try {
    process.kill = function (pid, signal) {
      if (pid === live.pid && signal === 0) { const error = new Error('synthetic permission denial'); error.code = 'EPERM'; throw error }
      return kill.call(process, pid, signal)
    }
    observer = createDatabase(filename)
    observer.recoverAbandonedTurns()
    assert.equal(observer.getTurn(input.requestId).status, 'running')
    assert.throws(() => observer.exportData(), error => error.status === 409)
  } finally { process.kill = kill; observer?.close() }
})
