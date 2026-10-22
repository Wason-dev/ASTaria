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
    assert.deepEqual(savePreferences(db, { expected: getPreferences(db), value: next }).render, { profile: 'economy', quality: 'auto', glass: 'auto', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
    assert.equal(getPreferences(db).render.profile, 'economy')
    assert.throws(() => savePreferences(db, { expected: initial, value: initial }), /其他窗口/)
    for (const mutate of [p => { p.focus.focusMin = 0 }, p => { p.effect.style = 'unknown' }, p => { p.grid = 'false' }, p => { p.notifications.quietStart = '25:00' }, p => { p.assistant.unrecognized = true }]) {
      const invalid = structuredClone(next); mutate(invalid)
      assert.throws(() => savePreferences(db, { expected: next, value: invalid }))
      assert.deepEqual(getPreferences(db), next)
    }
  } finally { db.close() }
})

test('glass tone is independent from page theme and sampling preference', () => {
  const db = createDatabase(':memory:')
  try {
    const initial = getPreferences(db)
    assert.equal(initial.glassTone, 'light')
    const next = { ...initial, theme: 'dark', glass: 'soft', glassTone: 'dark' }
    assert.deepEqual(savePreferences(db, { expected: initial, value: next }), next)
    const changed = { ...next, theme: 'light', glass: 'clear', glassTone: 'light' }
    assert.deepEqual(savePreferences(db, { expected: next, value: changed }), changed)
    assert.equal(getPreferences(db).glassTone, 'light')
  } finally { db.close() }
})

test('legacy glass tone defaults preserve theme, blur and optimistic write checks', () => {
  const db = createDatabase(':memory:')
  try {
    const legacy = { ...getPreferences(db), theme: 'light', glass: 'soft' }
    delete legacy.glassTone
    db.setPreference('app', legacy)
    const migrated = getPreferences(db)
    assert.deepEqual(migrated, { ...legacy, glassTone: 'light' })
    const saved = savePreferences(db, { expected: legacy, value: { ...legacy, glassTone: 'dark' } })
    assert.equal(saved.theme, 'light'); assert.equal(saved.glass, 'soft')
    assert.throws(() => savePreferences(db, { expected: legacy, value: legacy }), /其他窗口/)
    for (const invalid of [null, 'white', 0]) {
      assert.throws(() => savePreferences(db, { expected: saved, value: { ...saved, glassTone: invalid } }), /玻璃深浅/)
      assert.deepEqual(getPreferences(db), saved)
    }
  } finally { db.close() }
})

test('preferences written before render profiles gain the full visual default', () => {
  const db = createDatabase(':memory:')
  try {
    const legacy = structuredClone(getPreferences(db))
    delete legacy.render
    db.setPreference('app', legacy)
    assert.deepEqual(getPreferences(db).render, { profile: 'full', quality: 'auto', glass: 'auto', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
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
      next.effect.binary = { enabled: false, brightness: 2, density: 0, emberBrightness: 0.03, visibleFraction: 0.005, sparkFrequency: 0, sparkBrightness: 0.2, flowSpeed: 0.4 }
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
      const outsideRange = key === 'brightness' ? [0.49, 3.01] : [-0.01, 1.01]
      for (const value of [...outsideRange, NaN, Infinity, '0.1', null]) invalidValues.push({ [key]: value })
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

test('saved digit tuning without brightness gains 125% without changing other preferences', () => {
  const db = createDatabase(':memory:')
  try {
    for (const useLegacyExpected of [true, false]) {
      const legacy = structuredClone(getPreferences(db))
      legacy.effect.binary = { enabled: false, density: .3, emberBrightness: .04, visibleFraction: .2, sparkFrequency: 0, sparkBrightness: .6, flowSpeed: .4 }
      db.setPreference('app', legacy)
      const migrated = getPreferences(db)
      assert.deepEqual(migrated, { ...legacy, effect: { ...legacy.effect, binary: { ...legacy.effect.binary, brightness: 1.25 } } })
      assert.deepEqual(db.getPreference('app'), legacy, 'reading a legacy record does not write it back')
      const next = structuredClone(migrated)
      next.effect.binary.brightness = 2.5
      assert.deepEqual(savePreferences(db, { expected: useLegacyExpected ? legacy : migrated, value: next }), next)
      assert.deepEqual(getPreferences(db), next)
    }
  } finally { db.close() }
})

test('digit brightness persists its full range and restores the default without changing disk or render settings', () => {
  const db = createDatabase(':memory:')
  try {
    const initial = getPreferences(db)
    for (const brightness of [.5, .55, 1, 1.25, 2.95, 3, DEFAULT_BINARY_EFFECT.brightness]) {
      const expected = getPreferences(db)
      const value = { ...expected, effect: { ...expected.effect, binary: { ...expected.effect.binary, brightness } } }
      assert.deepEqual(savePreferences(db, { expected, value }), value)
      assert.deepEqual(getPreferences(db), { ...initial, effect: { ...initial.effect, binary: { ...initial.effect.binary, brightness } } })
    }
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
        assert.deepEqual(migrated.render, { profile: 'economy', quality: 'low', glass: 'auto', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
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

test('media render preferences default to realtime, 1080p and high and persist every allowed choice', () => {
  const db = createDatabase(':memory:')
  try {
    const initial = getPreferences(db)
    assert.deepEqual(
      { background: initial.render.background, mediaResolution: initial.render.mediaResolution, mediaQuality: initial.render.mediaQuality },
      { background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' },
    )
    for (const background of ['realtime', 'video', 'image']) {
      for (const mediaResolution of ['4k', '1080p', '720p']) {
        for (const mediaQuality of ['high', 'standard']) {
          const expected = getPreferences(db)
          const value = { ...expected, render: { ...expected.render, background, mediaResolution, mediaQuality } }
          assert.deepEqual(savePreferences(db, { expected, value }), value)
          assert.deepEqual(getPreferences(db), value)
          assert.equal(getPreferences(db).render.profile, 'full')
          assert.equal(getPreferences(db).render.quality, 'auto')
          assert.equal(getPreferences(db).render.glass, 'auto')
        }
      }
    }
  } finally { db.close() }
})

test('older preferences without media render fields gain per-field defaults without write-back and stay editable', () => {
  const db = createDatabase(':memory:')
  try {
    const legacy = structuredClone(getPreferences(db))
    delete legacy.render.background
    delete legacy.render.mediaResolution
    delete legacy.render.mediaQuality
    db.setPreference('app', legacy)
    const migrated = getPreferences(db)
    assert.deepEqual(migrated.render, { profile: 'full', quality: 'auto', glass: 'auto', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
    assert.deepEqual(db.getPreference('app'), legacy, 'reading a legacy record does not write defaults back')
    for (const [useLegacyExpected, background, mediaResolution, mediaQuality] of [[true, 'video', '4k', 'standard'], [false, 'image', '720p', 'standard']]) {
      db.setPreference('app', legacy)
      const expected = useLegacyExpected ? legacy : getPreferences(db)
      const value = { ...getPreferences(db), render: { ...getPreferences(db).render, background, mediaResolution, mediaQuality } }
      assert.deepEqual(savePreferences(db, { expected, value }), value)
      assert.deepEqual(getPreferences(db), value)
    }
    const partial = structuredClone(getPreferences(db))
    partial.render = { profile: 'balanced', glass: 'detailed', background: 'video' }
    db.setPreference('app', partial)
    assert.deepEqual(getPreferences(db).render, {
      profile: 'balanced', quality: 'high', glass: 'detailed', background: 'video', mediaResolution: '1080p', mediaQuality: 'high',
    }, 'partial legacy render keeps profile/glass/quality migration while filling only missing media fields')
  } finally { db.close() }
})

test('invalid media render preferences are rejected without changing saved settings', () => {
  const db = createDatabase(':memory:')
  try {
    const current = getPreferences(db)
    for (const patch of [
      { background: 'stream' }, { background: null }, { background: true }, { background: 0 },
      { mediaResolution: '2k' }, { mediaResolution: '1080' }, { mediaResolution: null }, { mediaResolution: false },
      { mediaQuality: 'ultra' }, { mediaQuality: 'HIGH' }, { mediaQuality: false }, { mediaQuality: {} },
    ]) {
      const value = { ...current, render: { ...current.render, ...patch } }
      assert.throws(() => savePreferences(db, { expected: current, value }), /背景渲染|媒体分辨率|媒体画质/)
      assert.deepEqual(getPreferences(db), current)
    }
    assert.throws(() => savePreferences(db, { expected: current, value: { ...current, render: { ...current.render, media: '4k' } } }), /渲染/)
    assert.deepEqual(getPreferences(db), current)
    db.setPreference('app', { ...current, render: { ...current.render, background: 'loop' } })
    assert.throws(() => getPreferences(db), /背景渲染/, 'a persisted invalid value is not silently normalized')
  } finally { db.close() }
})

test('backups saved before media render fields restore with defaults and remain editable', () => {
  const source = createDatabase(':memory:'), restored = createDatabase(':memory:')
  try {
    const legacy = structuredClone(getPreferences(source))
    delete legacy.render.background
    delete legacy.render.mediaResolution
    delete legacy.render.mediaQuality
    source.setPreference('app', legacy)
    restored.importData(source.exportData())
    const restoredPreferences = getPreferences(restored)
    assert.deepEqual(restoredPreferences, getPreferences(source), 'restoring only defaults the missing media fields')
    assert.deepEqual(restoredPreferences.render, { profile: 'full', quality: 'auto', glass: 'auto', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
    const next = { ...restoredPreferences, render: { ...restoredPreferences.render, background: 'image', mediaResolution: '720p', mediaQuality: 'standard' } }
    assert.deepEqual(savePreferences(restored, { expected: legacy, value: next }), next)
    assert.deepEqual(getPreferences(restored), next)

    const roundTrip = createDatabase(':memory:')
    try {
      roundTrip.importData(restored.exportData())
      assert.deepEqual(getPreferences(roundTrip).render, next.render, 'normalized media fields survive another backup round-trip')
    } finally { roundTrip.close() }

    const sign = value => { value.checksum = createHash('sha256').update(JSON.stringify(value.tables)).digest('hex'); return value }
    const invalid = source.exportData()
    const row = invalid.tables.state.find(item => item.key === 'preferences:app')
    row.value = JSON.stringify({ ...legacy, render: { ...legacy.render, mediaQuality: 'lossless' } })
    const before = getPreferences(restored), beforeRaw = structuredClone(restored.getPreference('app'))
    assert.throws(() => restored.importData(sign(invalid)), /媒体画质/)
    assert.deepEqual(getPreferences(restored), before, 'an invalid backup cannot overwrite live preferences')
    assert.deepEqual(restored.getPreference('app'), beforeRaw, 'a rejected backup rolls back the raw record too')
  } finally { source.close(); restored.close() }
})
