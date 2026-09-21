import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { getPreferences, savePreferences } from '../server/preferences.mjs'

test('card edge choices persist across database connections and reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-card-edges-'))
  const file = join(directory, 'test.sqlite')
  const first = createDatabase(file), second = createDatabase(file)
  try {
    assert.equal(getPreferences(first).cardEdges, 'both')
    for (const cardEdges of ['left', 'none', 'both']) {
      const expected = getPreferences(first)
      const next = { ...expected, cardEdges }
      assert.deepEqual(savePreferences(first, { expected, value: next }), next)
      assert.equal(getPreferences(second).cardEdges, cardEdges)
    }
    const old = getPreferences(first)
    savePreferences(second, { expected: old, value: { ...old, cardEdges: 'none' } })
    assert.throws(() => savePreferences(first, { expected: old, value: { ...old, cardEdges: 'left' } }), /其他窗口/)
  } finally { first.close(); second.close() }
  const reopened = createDatabase(file)
  try { assert.equal(getPreferences(reopened).cardEdges, 'none') }
  finally { reopened.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('older preferences and backups gain symmetric edges and remain editable', () => {
  const source = createDatabase(':memory:'), restored = createDatabase(':memory:')
  try {
    const old = structuredClone(getPreferences(source))
    delete old.cardEdges
    source.setPreference('app', old)
    assert.equal(getPreferences(source).cardEdges, 'both')
    restored.importData(source.exportData())
    assert.equal(getPreferences(restored).cardEdges, 'both')
    const saved = savePreferences(restored, { expected: old, value: { ...getPreferences(restored), cardEdges: 'left' } })
    assert.equal(saved.cardEdges, 'left')
    source.importData(restored.exportData())
    assert.equal(getPreferences(source).cardEdges, 'left')
  } finally { source.close(); restored.close() }
})

test('invalid card edges cannot overwrite the saved choice or other preferences', () => {
  const db = createDatabase(':memory:')
  try {
    const expected = getPreferences(db)
    for (const cardEdges of ['right', 'double', '', null, false, 2, {}]) {
      assert.throws(() => savePreferences(db, { expected, value: { ...expected, cardEdges } }), /卡片装饰线/)
      assert.deepEqual(getPreferences(db), expected)
    }
  } finally { db.close() }
})
