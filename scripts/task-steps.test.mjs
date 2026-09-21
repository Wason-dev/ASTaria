import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { prepareTaskSteps, toggleTaskStep } from '../server/taskSteps.mjs'
import { taskSteps } from '../src/domain/taskSteps.ts'

const doneAt = '2026-09-19T08:30:00.000Z'
const steps = () => [{ id: 'outline', title: '列出提纲', detail: '先写三个小标题' }, { id: 'draft', title: '写出初稿' }]
const draft = status => ({ title: '物理报告', notes: '已有实验数据', status, due: '2026-10-01', estimateMin: 105,
  importance: 3, inbox: false, context: ['library'], subSteps: steps() })
const statusIs = status => error => error.status === status
const versionless = ({ updatedAt, ...value }) => value

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-task-steps-'))
  const filename = join(directory, 'test.sqlite')
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  const close = db => { db.close(); connections.delete(db) }
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db: open(), open, close }
}

const toggle = (db, task, stepId, checked) => toggleTaskStep(db, { taskId: task.id, stepId, checked, expectedUpdatedAt: task.updatedAt })

function invoke(service, path, payload, { headers = {}, socket = {} } = {}) {
  return new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))])
    request.url = `/api${path}`
    request.method = 'POST'
    request.socket = { remoteAddress: '127.0.0.1', localPort: 5188, ...socket }
    request.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json', ...headers }
    const response = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }
    service.middleware(request, response, () => resolve({ status: 404 }))
  })
}

test('taskSteps renders only canonical, unambiguous records while leaving legacy values untouched', () => {
  const valid = [...steps(), { id: 'finished', title: '阅读要求', doneAt }]
  const unknown = [null, '旧步骤', false, { title: '旧完成项', done: true }, { id: 'empty', title: '' },
    { id: 'extra', title: '旧字段', checked: true }, { id: 'bad-date', title: '坏日期', doneAt: '2026-02-30T09:00:00Z' },
    { id: 'bad-time', title: '坏时间', doneAt: '2026-09-19T24:00:00Z' }, { id: 'bad-type', title: '坏类型', detail: 42 }]
  const duplicates = [{ id: 'same', title: '甲' }, { id: 'same', title: '乙' }]
  const task = { subSteps: [...valid, ...unknown, ...duplicates] }, before = structuredClone(task)
  assert.deepEqual(taskSteps(task), valid)
  assert.deepEqual(task, before)
  assert.deepEqual(taskSteps({}), [])
  assert.deepEqual(taskSteps({ subSteps: null }), [])
})

test('AI re-splitting retains IDs, checked timestamps, omitted steps and details without mutating the task', () => {
  const task = { subSteps: [{ ...steps()[0], doneAt }, steps()[1], { id: 'review', title: '校对报告', doneAt }] }
  const before = structuredClone(task), generated = []
  const result = prepareTaskSteps(task, [
    { title: '列出提纲' }, { id: 'draft', title: '写出完整初稿', detail: '把实验结果补进去' }, { title: '提交报告' },
  ], index => { generated.push(index); return `new-${index}` })
  assert.deepEqual(generated, [2])
  assert.deepEqual(result, [
    task.subSteps[0], { id: 'draft', title: '写出完整初稿', detail: '把实验结果补进去' },
    { id: 'new-2', title: '提交报告' }, task.subSteps[2],
  ])
  assert.deepEqual(task, before)
  assert.deepEqual(prepareTaskSteps({}, [{ title: '  开始  ', detail: '  看要求  ' }], () => 'first'), [{ id: 'first', title: '开始', detail: '看要求' }])
})

test('explicit IDs reserve old steps before implicit title matching and never inherit another step completion', () => {
  const task = { subSteps: [{ id: 'a', title: '第一步', doneAt }, { id: 'b', title: '第二步' }] }
  const result = prepareTaskSteps(task, [{ title: '第一步' }, { id: 'a', title: '第一步的新标题' }], index => `new-${index}`)
  assert.deepEqual(result, [{ id: 'new-0', title: '第一步' }, { id: 'a', title: '第一步的新标题', doneAt }, task.subSteps[1]])
  assert.throws(() => prepareTaskSteps(task, [{ id: 'b', title: '第一步' }], () => 'unused'), statusIs(400))
})

test('AI step validation rejects forged progress, duplicate identities and malformed proposals', () => {
  const task = { subSteps: steps() }
  const invalid = [
    undefined, {}, [], Array.from({ length: 31 }, (_, index) => ({ title: `step-${index}` })), [null],
    [{ title: '' }], [{ title: 'x'.repeat(161) }], [{ title: 'valid', detail: 'x'.repeat(601) }],
    [{ title: 'valid', detail: null }], [{ title: 'valid', doneAt }], [{ title: 'valid', checked: true }],
    [{ title: 'valid', done: true }], [{ title: 'valid', extra: 'unsupported' }], [{ id: 5, title: 'valid' }],
    [{ title: 'same' }, { title: ' same ' }], [{ id: 'outline', title: 'one' }, { id: 'outline', title: 'two' }],
  ]
  for (const value of invalid) assert.throws(() => prepareTaskSteps(task, value, index => `new-${index}`), statusIs(400))
  assert.throws(() => prepareTaskSteps(task, [{ id: 'missing', title: 'valid' }], () => 'unused'), statusIs(409))
  assert.throws(() => prepareTaskSteps(task, [{ title: 'new' }], () => 'draft'), statusIs(400))
  assert.throws(() => prepareTaskSteps({}, [{ title: 'one' }, { title: 'two' }], () => 'same'), statusIs(400))
  assert.equal(prepareTaskSteps({}, Array.from({ length: 30 }, (_, index) => ({ title: `step-${index}` })), index => `id-${index}`).length, 30)
})

test('AI re-splitting refuses to silently remove or replace legacy and ambiguous records', () => {
  for (const old of [
    [{ title: '老步骤', done: true }], [null], ['旧步骤'], [...steps(), { id: 'draft', title: '重复 ID' }],
    [{ id: 'checked', title: '旧完成时间', doneAt: 'yesterday' }],
  ]) {
    const task = { subSteps: old }, before = structuredClone(task)
    assert.throws(() => prepareTaskSteps(task, [{ title: '重新开始' }], () => 'new'), statusIs(409))
    assert.deepEqual(task, before)
  }
})

for (const status of ['todo', 'doing', 'done']) {
  test(`checking and unchecking steps preserves all task fields and ${status} status even when every step is checked`, t => {
    const { db } = fixture(t)
    const before = db.createTask(draft(status))
    const assignment = db.saveAssignment({ taskId: before.id, blockId: '2026-09-20:P1', plannedMin: 35, reason: '已有安排' })
    const first = toggle(db, before, 'outline', true)
    const all = toggle(db, first, 'draft', true)
    assert.ok(all.subSteps.every(step => Number.isFinite(Date.parse(step.doneAt))))
    const unchecked = toggle(db, all, 'outline', false)
    assert.equal(Object.hasOwn(unchecked.subSteps[0], 'doneAt'), false)
    assert.equal(unchecked.subSteps[1].doneAt, all.subSteps[1].doneAt)
    const { subSteps: beforeSteps, ...beforeFields } = versionless(before)
    const { subSteps: afterSteps, ...afterFields } = versionless(unchecked)
    assert.deepEqual(afterFields, beforeFields)
    assert.deepEqual(afterSteps[0], beforeSteps[0])
    assert.ok(Date.parse(unchecked.updatedAt) > Date.parse(all.updatedAt))
    assert.deepEqual(db.listAssignments(), [assignment])
    assert.equal(db.listTaskCompletionHistory(before.id).length, status === 'done' ? 1 : 0)
  })
}

test('independent browser connections and service restart share checked steps and reject stale updates', t => {
  const { db: first, open, close } = fixture(t), second = open()
  const original = first.createTask(draft('doing')), stale = second.getTask(original.id)
  const checked = toggle(first, original, 'outline', true)
  assert.deepEqual(second.getTask(original.id), checked)
  assert.throws(() => toggle(second, stale, 'draft', true), statusIs(409))
  assert.deepEqual(first.getTask(original.id), checked)
  const both = toggle(second, second.getTask(original.id), 'draft', true)
  close(first); close(second)
  const restarted = open()
  assert.deepEqual(restarted.getTask(original.id), both)
  const unchecked = toggle(restarted, both, 'outline', false)
  assert.equal(open().getTask(original.id).subSteps[0].doneAt, undefined)
  assert.equal(unchecked.subSteps[1].doneAt, both.subSteps[1].doneAt)
})

test('toggle preserves unknown legacy items and repeated desired state is idempotent after checking the version', t => {
  const { db } = fixture(t)
  const legacy = [{ title: '旧步骤', done: true }, null, '旧文字', { id: 'outline', title: '旧结构', extra: 1 }]
  const original = db.createTask({ ...draft('todo'), subSteps: [...steps(), ...legacy] })
  const checked = toggle(db, original, 'outline', true)
  assert.deepEqual(checked.subSteps.slice(2), legacy)
  assert.deepEqual(toggle(db, checked, 'outline', true), checked)
  assert.throws(() => toggle(db, original, 'outline', true), statusIs(409))
  assert.deepEqual(db.getTask(original.id), checked)
  assert.throws(() => toggle(db, checked, 'missing', true), statusIs(404))
  const duplicated = db.updateTask(original.id, { subSteps: [...checked.subSteps, { id: 'outline', title: '冲突项' }] })
  assert.throws(() => toggle(db, duplicated, 'outline', false), statusIs(409))
  assert.deepEqual(db.getTask(original.id), duplicated)
})

test('invalid, deleted and dropped task checks reject without writing and outer rollback restores progress', t => {
  const { db } = fixture(t), original = db.createTask(draft('todo'))
  const input = { taskId: original.id, stepId: 'outline', checked: true, expectedUpdatedAt: original.updatedAt }
  for (const patch of [{ checked: 'true' }, { checked: 1 }, { checked: null }, { checked: undefined },
    { expectedUpdatedAt: undefined }, { expectedUpdatedAt: 'yesterday' }, { expectedUpdatedAt: '2026-09-20' },
    { taskId: '' }, { stepId: '' }, { doneAt }, { status: 'done' }]) {
    assert.throws(() => toggleTaskStep(db, { ...input, ...patch }), statusIs(400))
  }
  assert.deepEqual(db.getTask(original.id), original)
  assert.throws(() => toggleTaskStep(db, { ...input, taskId: 'missing' }), statusIs(404))
  assert.throws(() => db.transaction(() => { toggle(db, original, 'outline', true); throw new Error('rollback') }), /rollback/u)
  assert.deepEqual(db.getTask(original.id), original)
  const dropped = db.updateTask(original.id, { status: 'dropped' })
  assert.throws(() => toggle(db, dropped, 'outline', true), statusIs(409))
  const deleted = db.deleteTask(original.id)
  assert.throws(() => toggle(db, deleted, 'outline', true), statusIs(409))
  assert.deepEqual(db.getTask(original.id), deleted)
})

test('backup export/import retains canonical completion and legacy raw steps and invalidates old browser versions', t => {
  const { db } = fixture(t)
  const legacy = [{ title: '旧信息', done: true }, 'old']
  const original = db.createTask({ ...draft('doing'), subSteps: [...steps(), ...legacy] })
  const checked = toggle(db, original, 'outline', true), backup = db.exportData()
  const target = createDatabase(':memory:')
  t.after(() => target.close())
  assert.equal(target.importData(backup).restored, true)
  const restored = target.getTask(original.id)
  assert.deepEqual(restored.subSteps, checked.subSteps)
  assert.notEqual(restored.updatedAt, checked.updatedAt)
  assert.throws(() => toggle(target, checked, 'draft', true), statusIs(409))
  const continued = toggle(target, restored, 'draft', true)
  assert.deepEqual(continued.subSteps.slice(2), legacy)
  assert.equal(continued.subSteps[0].doneAt, checked.subSteps[0].doneAt)
})

test('HTTP check enforces local permissions, strict fields and versions without reading credentials or calling AI', async t => {
  const { db } = fixture(t), original = db.createTask(draft('doing'))
  let privateCalls = 0
  const forbidden = () => { privateCalls++; throw new Error('must not access provider or keychain') }
  const service = createLocalService({ db, vault: { status: forbidden, read: forbidden }, complete: forbidden })
  const input = { taskId: original.id, stepId: 'outline', checked: true, expectedUpdatedAt: original.updatedAt }
  for (const options of [
    { headers: { 'x-astaria-local': undefined } }, { headers: { origin: 'https://evil.example' } },
    { headers: { host: 'evil.example:5188' } }, { headers: { 'sec-fetch-site': 'cross-site' } },
    { socket: { remoteAddress: '192.168.0.8' } },
  ]) assert.equal((await invoke(service, '/tasks/steps/check', input, options)).status, 403)
  assert.equal((await invoke(service, '/tasks/steps/check', input, { headers: { 'content-type': 'text/plain' } })).status, 415)
  for (const patch of [{ checked: 'true' }, { expectedUpdatedAt: undefined }, { doneAt }, { taskId: undefined }, { stepId: undefined }, { extra: true }]) {
    assert.equal((await invoke(service, '/tasks/steps/check', { ...input, ...patch })).status, 400)
  }
  assert.deepEqual(db.getTask(original.id), original)
  const response = await invoke(service, '/tasks/steps/check', input)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, db.getTask(original.id))
  assert.ok(response.body.subSteps[0].doneAt)
  assert.equal(response.body.status, 'doing')
  const stale = await invoke(service, '/tasks/steps/check', input)
  assert.equal(stale.status, 409)
  assert.equal(typeof stale.body.error, 'string')
  const unchecked = await invoke(service, '/tasks/steps/check', { ...input, checked: false, expectedUpdatedAt: response.body.updatedAt })
  assert.equal(unchecked.status, 200)
  assert.equal(unchecked.body.subSteps[0].doneAt, undefined)
  assert.equal(privateCalls, 0)
})
