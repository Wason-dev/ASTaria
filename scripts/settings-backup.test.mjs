import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { DEFAULT_BINARY_EFFECT, getPreferences, savePreferences } from '../server/preferences.mjs'

test('preferences persist on the local database, validate values and reject stale writes', () => {
  const db = createDatabase(':memory:')
  try {
    const initial = getPreferences(db), next = structuredClone(initial)
    next.effect.style = 'filaments'; next.grid = false; next.focus.focusMin = 45
    assert.deepEqual(savePreferences(db, { expected: initial, value: next }), next)
    assert.deepEqual(getPreferences(db), next)
    next.render.profile = 'economy'
    assert.deepEqual(savePreferences(db, { expected: getPreferences(db), value: next }).render, { profile: 'economy' })
    assert.equal(getPreferences(db).render.profile, 'economy')
    assert.throws(() => savePreferences(db, { expected: initial, value: initial }), /其他窗口/)
    for (const mutate of [p => { p.focus.focusMin = 0 }, p => { p.effect.style = 'unknown' }, p => { p.grid = 'false' }, p => { p.notifications.quietStart = '25:00' }, p => { p.assistant.unrecognized = true }]) {
      const invalid = structuredClone(next); mutate(invalid)
      assert.throws(() => savePreferences(db, { expected: next, value: invalid }))
      assert.deepEqual(getPreferences(db), next)
    }
  } finally { db.close() }
})

test('preferences written before render profiles gain the full visual default', () => {
  const db = createDatabase(':memory:')
  try {
    const legacy = structuredClone(getPreferences(db))
    delete legacy.render
    db.setPreference('app', legacy)
    assert.deepEqual(getPreferences(db).render, { profile: 'full' })
  } finally { db.close() }
})

test('legacy binary preferences gain defaults and remain editable with legacy or normalized expectations', () => {
  const db = createDatabase(':memory:')
  try {
    for (const useLegacyExpected of [true, false]) {
      const legacy = structuredClone(getPreferences(db))
      delete legacy.effect.binary
      db.setPreference('app', legacy)
      const migrated = getPreferences(db)
      assert.deepEqual(migrated.effect.binary, DEFAULT_BINARY_EFFECT)
      const next = structuredClone(migrated)
      next.effect.binary = { enabled: false, density: 0, emberBrightness: 0.03, visibleFraction: 0.005, sparkFrequency: 0, sparkBrightness: 0.2, flowSpeed: 0.4 }
      assert.deepEqual(savePreferences(db, { expected: useLegacyExpected ? legacy : migrated, value: next }), next)
      assert.deepEqual(getPreferences(db).effect.binary, next.effect.binary)
    }
  } finally { db.close() }
})

test('binary preference validation rejects malformed values without changing saved settings', () => {
  const db = createDatabase(':memory:')
  try {
    const current = getPreferences(db)
    const invalidValues = [null, [], false, { unknown: 1 }, { enabled: 0 }]
    for (const key of Object.keys(DEFAULT_BINARY_EFFECT).filter(key => key !== 'enabled')) {
      for (const value of [-0.01, 1.01, NaN, Infinity, '0.1', null]) invalidValues.push({ [key]: value })
    }
    for (const binary of invalidValues) {
      const value = structuredClone(current)
      value.effect.binary = binary
      assert.throws(() => savePreferences(db, { expected: current, value }))
      assert.deepEqual(getPreferences(db), current)
    }
    const partial = structuredClone(current)
    partial.effect.binary = { enabled: false }
    assert.deepEqual(savePreferences(db, { expected: current, value: partial }).effect.binary, { ...DEFAULT_BINARY_EFFECT, enabled: false })
  } finally { db.close() }
})

test('legacy rest profile migrates to economy and remains editable using either legacy or normalized expected preferences', () => {
  const db = createDatabase(':memory:')
  try {
    for (const profile of ['smooth120', 'smooth90', 'full', 'balanced', 'economy']) {
      for (const useLegacyExpected of [true, false]) {
        const legacy = { ...getPreferences(db), render: { profile: 'rest' } }
        db.setPreference('app', legacy)
        const migrated = getPreferences(db)
        assert.deepEqual(migrated.render, { profile: 'economy' })
        const expected = useLegacyExpected ? legacy : migrated
        const saved = savePreferences(db, { expected, value: { ...migrated, render: { profile } } })
        assert.equal(saved.render.profile, profile)
        assert.equal(getPreferences(db).render.profile, profile)
        assert.equal(db.getPreference('app').render.profile, profile)
      }
    }
  } finally { db.close() }
})

test('legacy calendar startup preferences open the unified schedule and remain editable', () => {
  const db = createDatabase(':memory:')
  try {
    for (const legacy of ['calendar', 'timetable']) {
      const saved = { ...getPreferences(db), startupPage: legacy }
      db.setPreference('app', saved)
      const current = getPreferences(db)
      assert.equal(current.startupPage, 'schedule')
      assert.equal(savePreferences(db, { expected: saved, value: { ...current, startupPage: 'companion' } }).startupPage, 'companion')
    }
  } finally { db.close() }
})

test('backup restores tasks, conversations, memories and preferences without credentials', () => {
  const db = createDatabase(':memory:')
  try {
    const task = db.createTask({ title: '保留的任务', estimateMin: 35 })
    const conversation = db.getActiveConversation()
    const source = db.appendMessage({ conversationId: conversation.id, role: 'user', content: '我喜欢安静的上午' })
    db.rememberMemory({ content: '喜欢安静的上午', scope: 'global', kind: 'preference', sourceMessageId: source.id })
    db.getPlanner()
    const backup = db.exportData()
    assert.equal(backup.format, 'astaria-backup')
    assert.equal(Object.keys(backup.tables).some(key => /keychain|secret|credential/i.test(key)), false)
    db.updateTask(task.id, { title: '稍后的修改' })
    const newTask = db.createTask({ title: '新任务' })
    db.importData(backup)
    assert.throws(() => db.updateTask(task.id, { title: '来自旧窗口' }, task.updatedAt), /其他窗口/)
    assert.equal(db.getTask(task.id).title, '保留的任务')
    assert.equal(db.getTask(newTask.id), null)
    assert.equal(db.listMessages(conversation.id)[0].content, '我喜欢安静的上午')
    assert.equal(db.listMemories()[0].content, '喜欢安静的上午')
    assert.ok(db.getPlanner().revision > JSON.parse(backup.tables.state.find(row => row.key === 'planner-v1').value).revision)
  } finally { db.close() }
})

test('bad backup is rejected before commit and cannot overwrite live data', () => {
  const db = createDatabase(':memory:')
  try {
    const task = db.createTask({ title: '不能丢的事项' }), backup = db.exportData()
    const sign = value => { value.checksum = createHash('sha256').update(JSON.stringify(value.tables)).digest('hex'); return value }
    const unknown = structuredClone(backup); unknown.tables.state.push({ key: 'secret', value: 'secret' }); sign(unknown)
    assert.throws(() => db.importData(unknown), /不支持/)
    const invalid = structuredClone(backup); const record = JSON.parse(invalid.tables.tasks[0].document); record.status = 'invalid'; invalid.tables.tasks[0].document = JSON.stringify(record); sign(invalid)
    assert.throws(() => db.importData(invalid))
    assert.equal(db.getTask(task.id).title, '不能丢的事项')
    const corrupt = structuredClone(backup); corrupt.checksum = 'invalid'
    assert.throws(() => db.importData(corrupt), /校验/)
    assert.equal(db.getTask(task.id).title, '不能丢的事项')
  } finally { db.close() }
})

test('memory correction records fresh user evidence and preserves the prior source', () => {
  const db = createDatabase(':memory:')
  try {
    const source = db.appendMessage({ conversationId: db.getActiveConversation().id, role: 'user', content: '我周末八点起' })
    const before = db.rememberMemory({ content: '周末八点起', scope: 'global', kind: 'preference', sourceMessageId: source.id })
    const after = db.correctMemory(before.id, { expectedUpdatedAt: before.updatedAt, content: '周末九点起' })
    assert.equal(after.replacesId, before.id)
    assert.equal(db.listMemories().length, 1)
    assert.equal(db.getMessage(source.id).content, '我周末八点起')
    assert.equal(db.getMessage(after.sourceMessageId).content, '更正记忆：周末九点起')
    assert.throws(() => db.correctMemory(before.id, { expectedUpdatedAt: before.updatedAt, content: '旧写入' }), /失效/)
  } finally { db.close() }
})
