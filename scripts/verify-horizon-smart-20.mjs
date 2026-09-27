import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'
import { createHorizonGrouping } from '../server/horizonGroups.mjs'
import { createCompletion } from '../server/provider.mjs'
import { createKeychain } from '../server/keychain.mjs'
import { getModelSettings } from '../server/modelSettings.mjs'

// An explicit opt-in harness, never included in npm test. Only synthetic tasks
// are sent to the selected model. The personal DB is opened read-only to read
// the model selection; the existing keychain helper handles the credential.
if (!process.argv.includes('--live')) throw new Error('This calls the selected model. Pass --live explicitly.')
process.env.TZ = 'Asia/Shanghai'
const root = resolve(import.meta.dirname, '..')
const output = resolve(process.env.ASTARIA_GROUP_TEST_OUTPUT || join(root, 'desktop-builds/0.1.0-beta.1/smart-group-20-2026-09-26'))
const fixtureText = await readFile(join(root, 'scripts/fixtures/horizon-smart-20.json'), 'utf8')
const fixture = JSON.parse(fixtureText), { items } = fixture
assert.equal(items.length, 20)
assert.equal(new Set(items.map(item => item.id)).size, 20)
for (const day of [0, 1, 2]) {
  const tasks = items.filter(item => item.day === day)
  assert.ok(tasks.length >= 4)
  assert.ok(tasks.reduce((sum, item) => sum + item.minutes, 0) <= 240)
}
for (const item of items) {
  assert.ok([15, 20, 25, 30, 40].includes(item.minutes))
  assert.ok(!Object.keys(item).some(key => key.startsWith('group')))
}

const dataDirectory = join(homedir(), 'Library/Application Support/ASTaria')
const configDb = new DatabaseSync(join(dataDirectory, 'astaria.sqlite'), { readOnly: true })
let config
try {
  configDb.exec('BEGIN')
  const state = key => configDb.prepare('SELECT value FROM state WHERE key = ?').get(key)?.value
  config = getModelSettings({
    getModel: () => state('deepseekModel') || 'deepseek-flash',
    getPreference: key => { const value = state(`preferences:${key}`); return value ? JSON.parse(value) : undefined },
  })
} finally { configDb.exec('ROLLBACK'); configDb.close() }
const helper = join(root, 'desktop-builds/0.1.0-beta.1/current/ASTaria-0.1.0-beta.1-mac-arm64/ASTaria.app/Contents/Resources/app/bin/astaria-keychain')
const vault = createKeychain(dataDirectory, { binaryPath: helper })
const requests = [], events = []
let requestStart, firstDeltaMs, firstContentMs, completionMs
const complete = createCompletion(vault, async (url, options) => {
  const body = JSON.parse(options.body)
  requests.push({ model: body.model, effort: body.reasoning_effort ?? null, stream: body.stream, thinking: body.thinking?.type ?? null })
  return fetch(url, options)
}, () => config.cloudModel, () => config)
const measured = async (payload, options) => {
  requestStart = performance.now()
  const result = await complete(payload, { ...options, onDelta: event => {
    if (event.delta && firstDeltaMs === undefined) firstDeltaMs = performance.now() - requestStart
    if (event.type === 'content' && event.delta && firstContentMs === undefined) firstContentMs = performance.now() - requestStart
    options.onDelta?.(event)
  } })
  completionMs = performance.now() - requestStart
  return result
}
const db = createDatabase(':memory:')
const date = '2026-09-26', dates = [date, '2026-09-27', '2026-09-28']
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
try {
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const routine of db.getPlanner().routines) act({ type: 'delete-routine', id: routine.id })
  act({ type: 'save-routine', routine: { id: 'test-availability', title: '测试空档', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '08:00', end: '23:30', location: '', items: [], enabled: true } })
  const goals = new Map(), cursors = [9 * 60, 9 * 60, 9 * 60]
  for (const item of items) {
    if (item.goal && !goals.has(item.goal)) goals.set(item.goal, { id: `test-goal-${goals.size + 1}`, title: item.goal })
    const goal = goals.get(item.goal)
    const task = db.createTask({ title: item.title, area: item.area, energy: item.energy, estimateMin: item.minutes,
      ...(goal ? { freeTimeGoalId: goal.id } : {}) })
    if (goal && !goal.taskId) goal.taskId = task.id
    const start = cursors[item.day]
    act({ type: 'save-block', block: { id: item.id, taskId: task.id, date: dates[item.day], start: clock(start), end: clock(start + item.minutes), locked: false } })
    cursors[item.day] += item.minutes + 10
  }
  db.saveCompanionState({ ...db.getCompanionState(), freeTimeGoals: [...goals.values()] })
  const horizon = createHorizonOrder({ db, now: () => new Date(`${date}T08:00:00+08:00`) })
  const initial = horizon.list({ date }), before = db.exportData().tables
  assert.equal(initial.items.length, 20)
  const service = createHorizonGrouping({ list: horizon.list, complete: measured })
  const started = new Date().toISOString(), start = performance.now()
  const result = await service.suggest({ date, expectedRevision: initial.revision, snapshotKey: initial.snapshotKey, requestId: randomUUID() }, {
    onEvent: event => events.push({ elapsedMs: Math.round(performance.now() - start), ...event }),
  })
  const elapsedMs = performance.now() - start
  const assigned = result.groups.flatMap(group => group.tasks.map(task => ({ ...task, day: group.day })))
  assert.equal(assigned.length, 20)
  assert.equal(new Set(assigned.map(task => task.id)).size, 20)
  assert.deepEqual([...assigned.map(task => task.id)].sort(), items.map(item => item.id).sort())
  for (const task of assigned) {
    const original = items.find(item => item.id === task.id)
    assert.equal(task.day, original.day)
    assert.equal(task.title, original.title)
    assert.equal(task.minutes, original.minutes)
  }
  assert.ok(result.groups.every(group => group.tasks.length >= 1 && group.tasks.length <= 6))
  assert.deepEqual(db.exportData().tables, before)
  const cacheStart = performance.now()
  const cached = await service.suggest({ date, expectedRevision: initial.revision, snapshotKey: initial.snapshotKey, requestId: randomUUID() })
  const cacheMs = performance.now() - cacheStart
  assert.deepEqual(cached, result)
  assert.equal(requests.length, 1)
  const evidence = {
    started, seed: fixture.meta.seed, fixtureSha256: createHash('sha256').update(fixtureText).digest('hex'),
    isolation: { taskDatabase: ':memory:', modelConfigDatabase: 'read-only', clock: `${date}T08:00:00+08:00`, writesToPersonalData: 0 },
    requests, timing: { elapsedMs, completionMs, firstDeltaMs: firstDeltaMs ?? null, firstContentMs: firstContentMs ?? null, cacheMs },
    checks: { count: 20, unique: true, completeCoverage: true, daysUnchanged: true, durationUnchanged: true, titlesUnchanged: true, max6: true, noDatabaseMutation: true, cacheCalls: 0 },
    input: fixture, initialGroups: initial.groups, result, events,
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ output, requests, timing: evidence.timing, initialGroups: initial.groups.length, groups: result.groups, checks: evidence.checks }, null, 2))
} finally { db.close() }
