// Reproduce the three findings against the committed pre-fix storage modules.
// Only source code is read from Git; all databases and fixtures are synthetic.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
const root = fileURLToPath(new URL('../', import.meta.url))
const baseline = '0cd3206e5cfdf443a0fc3ef11db13c0ffa6031da'
const directory = mkdtempSync(join(tmpdir(), 'opus-storage-baseline-'))
const modules = ['databaseCore.mjs', 'database.mjs', 'backup.mjs', 'chatAttachments.mjs']
try {
  for (const name of modules) {
    const source = execFileSync('git', ['show', `${baseline}:server/${name}`], { cwd: root, encoding: 'utf8' })
    const rewritten = source.replace(/from (['"])(\.[^'"]+)\1/gu, (_match, _quote, relative) => {
      const basename = relative.startsWith('./') ? relative.slice(2) : ''
      const url = modules.includes(basename) ? pathToFileURL(join(directory, basename)) : new URL(relative, new URL(`../server/${name}`, import.meta.url))
      return `from ${JSON.stringify(url.href)}`
    })
    writeFileSync(join(directory, name), rewritten)
  }
  const { createDatabase } = await import(pathToFileURL(join(directory, 'database.mjs')).href)
  const filename = join(directory, 'synthetic.sqlite'), db = createDatabase(filename)
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOMatrCwMDAxAAGUAoAHaoBllxQ+i0AAAAASUVORK5CYII=', 'base64')
    const attachment = { name: 'synthetic.png', mime: 'image/png', size: png.length, data: `data:image/png;base64,${png.toString('base64')}` }
    db.beginTurn({ requestId: 'baseline', conversationId: 'main', text: '', context: { timezone: 'UTC' }, attachments: [attachment] })
    db.finishTurn('baseline', { status: 'completed' })
    const backup = db.exportData()
    const copies = ['messages', 'turns'].filter(table => backup.tables[table].some(row => JSON.parse(row.document).attachments?.[0]?.data === attachment.data))
    assert.deepEqual(copies, ['messages', 'turns'])
    console.log('R3 baseline: identical complete bytes present in both messages and turns')
    db.setPreference('mobile-reminders-enabled', true)
    db.importData(backup)
    assert.equal(db.getPreference('mobile-reminders-enabled'), null)
    console.log('R12 baseline: restoring backup clears local true reminder preference to null')
  } finally { db.close() }
  const raw = new DatabaseSync(filename)
  raw.prepare("UPDATE turns SET document=json_set(document,'$.status','running','$.ownerPid',1,'$.ownerToken','synthetic-old-owner') WHERE id='baseline'").run()
  raw.close()
  const reopened = createDatabase(filename)
  try {
    assert.equal(reopened.getTurn('baseline').status, 'running')
    assert.throws(() => reopened.exportData(), error => error.status === 409)
    console.log('R9 baseline: synthetic PID 1 owner stays running and blocks export with 409')
  } finally { reopened.close() }
  console.log(`Baseline commit: ${baseline}`)
} finally { rmSync(directory, { recursive: true, force: true }) }
