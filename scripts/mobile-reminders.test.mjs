import assert from 'node:assert/strict'
import test from 'node:test'
import { createMobileReminders } from '../mobile/runtime/reminders.ts'
import { buildReminderPlan } from '../server/reminderPlan.mjs'

process.env.TZ = 'Asia/Shanghai'
const NOW = new Date('2026-09-29T12:00:00+08:00')
const snapshot = (patch = {}) => ({
  tasks: [{ id: 't1', title: '虚构事项', status: 'todo', deletedAt: null, due: '2026-09-30' }],
  planner: { revision: 1, routines: [], blocks: [], details: {}, checked: {} },
  preferences: { notifications: { enabled: true, quietStart: '23:00', quietEnd: '08:00' } }, ...patch,
})
const platform = (name = 'ios', available = true) => ({ getPlatform: () => name, isNativePlatform: () => name !== 'web', isPluginAvailable: () => available })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture({ name = 'ios', enabled = false, permission = 'granted', value = snapshot(), entries = [], available = true } = {}) {
  const calls = [], saves = [], holder = { value, enabled, reads: 0, enabledReads: 0, fail: null, time: NOW, reader: null }
  const native = {
    entries: structuredClone(entries), permission, requested: 'granted', fail: null, ignoreCancel: false, ignoreSchedule: false, changeSchedule: null, scheduleGate: null,
    async checkPermissions() { calls.push(['check']); if (native.fail === 'check') throw Error('permission lookup failed'); return { display: native.permission } },
    async requestPermissions() { calls.push(['request']); if (native.fail === 'request') throw Error('permission request failed'); native.permission = native.requested; return { display: native.permission } },
    async getPending() { calls.push(['pending']); if (native.fail === 'pending') throw Error('pending read failed'); return { notifications: structuredClone(native.entries) } },
    async cancel({ notifications }) {
      calls.push(['cancel', structuredClone(notifications)])
      if (native.fail === 'cancel') throw Error('cancel failed')
      if (!native.ignoreCancel) native.entries = native.entries.filter(entry => !notifications.some(value => value.id === entry.id))
    },
    async schedule({ notifications }) {
      calls.push(['schedule', structuredClone(notifications)])
      if (native.scheduleGate) { const gate = native.scheduleGate; native.scheduleGate = null; gate.started.resolve(); await gate.resume.promise }
      if (native.fail === 'schedule') throw Error('schedule failed')
      if (!native.ignoreSchedule) for (const notification of notifications) {
        const copy = structuredClone(notification)
        // Native pending uses an ISO string, not the input JS Date.
        copy.schedule.at = copy.schedule.at.toISOString()
        native.changeSchedule?.(copy)
        native.entries = native.entries.filter(entry => entry.id !== copy.id).concat(copy)
      }
      return { notifications: notifications.map(({ id }) => ({ id })) }
    },
  }
  const service = createMobileReminders({
    readSnapshot: async () => { holder.reads++; if (holder.fail === 'snapshot') throw Error('read failed'); return holder.reader ? holder.reader() : structuredClone(holder.value) },
    readEnabled: async () => { holder.enabledReads++; if (holder.fail === 'enabled') throw Error('settings read failed'); return holder.enabled },
    saveEnabled: async value => { if (holder.fail === 'save') throw Error('settings save failed'); saves.push(value); holder.enabled = value },
  }, { platform: platform(name, available), notifications: native, now: () => holder.time })
  return { service, native, holder, calls, saves, of: name => calls.filter(call => call[0] === name) }
}

test('first status defaults to off and never requests or schedules; enabled state is loaded only once', async () => {
  const f = fixture({ enabled: undefined, permission: 'prompt' })
  const state = await f.service.status()
  assert.deepEqual([state.supported, state.enabled, state.authorization, state.count, state.error], [true, false, 0, 0, null])
  await f.service.refresh()
  assert.equal(f.holder.enabledReads, 1); assert.equal(f.holder.reads, 0)
  assert.equal(f.of('request').length, 0); assert.equal(f.of('schedule').length, 0); assert.deepEqual(f.saves, [])
})

test('only explicitly enabling can request permission, and denial does not persist enabled or report success', async () => {
  const f = fixture({ permission: 'prompt' }); f.native.requested = 'denied'
  await f.service.status(); await f.service.refresh(); await assert.rejects(f.service.test(), /先开启/u)
  assert.equal(f.of('request').length, 0)
  const denied = await f.service.setEnabled(true)
  assert.equal(denied.enabled, false); assert.equal(denied.count, 0); assert.match(denied.error, /允许/u); assert.deepEqual(f.saves, [])
  assert.equal(f.of('request').length, 1); assert.equal(f.of('schedule').length, 0)
  f.native.requested = 'granted'
  const granted = await f.service.setEnabled(true)
  assert.equal(granted.error, null); assert.equal(granted.enabled, true); assert.equal(granted.count, 1)
  assert.deepEqual(f.saves, [true])
  await f.service.status(); assert.equal(f.of('request').length, 2)
})

test('already granted permission is checked without prompting when enabling', async () => {
  const f = fixture(), state = await f.service.setEnabled(true)
  assert.equal(state.count, 1); assert.equal(f.of('request').length, 0); assert.ok(f.of('check').length > 0)
  const entry = f.native.entries[0]
  assert.deepEqual([entry.title, entry.body, entry.extra.at], Object.values(buildReminderPlan(f.holder.value, NOW).entries[0]).slice(1))
  assert.ok(Number.isInteger(entry.id) && entry.id > 0 && entry.id <= 2147483647)
  assert.equal(entry.isExactNotification, false, 'no implicit exact-alarm permission flow on Android')
})

test('foreground refreshes during the permission dialog do not discard an explicit enable choice', async () => {
  const f = fixture({ permission: 'prompt' }), started = deferred(), resume = deferred()
  f.native.requestPermissions = async () => { f.calls.push(['request']); started.resolve(); await resume.promise; f.native.permission = 'granted'; return { display: 'granted' } }
  const enabled = f.service.setEnabled(true); await started.promise
  const a = f.service.scheduleRefresh(), b = f.service.status()
  resume.resolve(); const state = await enabled; await Promise.all([a, b])
  assert.equal(state.enabled, true); assert.deepEqual(f.saves, [true]); assert.equal(f.native.entries.length, 1)
})

test('a newer disable choice supersedes a permission dialog without persisting enable or scheduling', async () => {
  const f = fixture({ permission: 'prompt' }), started = deferred(), resume = deferred()
  f.native.requestPermissions = async () => { started.resolve(); await resume.promise; return { display: 'granted' } }
  const enabled = f.service.setEnabled(true); await started.promise
  const disabled = f.service.setEnabled(false); resume.resolve(); await enabled
  assert.equal((await disabled).enabled, false); assert.deepEqual(f.saves, [false]); assert.equal(f.of('schedule').length, 0)
})

test('a permission revocation immediately before schedule is not allowed to trigger an implicit permission request', async () => {
  const f = fixture({ enabled: true }); let checks = 0
  f.native.checkPermissions = async () => { f.calls.push(['check']); return { display: ++checks === 1 ? 'granted' : 'denied' } }
  const state = await f.service.refresh()
  assert.ok(state.error); assert.equal(state.authorization, 1); assert.equal(state.count, 0)
  assert.equal(f.of('schedule').length, 0); assert.equal(f.of('request').length, 0)
})

test('web preview and unregistered native plugins do not call any notification API', async () => {
  for (const args of [{ name: 'web', enabled: true }, { name: 'windows' }, { available: false }]) {
    const f = fixture(args)
    const state = await f.service.status()
    assert.equal(state.supported, false); assert.equal(state.enabled, false)
    assert.equal((await f.service.setEnabled(true)).count, 0)
    await assert.rejects(f.service.test())
    assert.deepEqual(f.calls, []); assert.deepEqual(f.saves, [])
  }
})

test('changing time and then title replaces old native ids before scheduling; unchanged plans do not reschedule', async () => {
  const f = fixture({ enabled: true, name: 'android' })
  await f.service.refresh(); const first = structuredClone(f.native.entries[0])
  await f.service.refresh(); assert.equal(f.of('schedule').length, 1)
  f.holder.value.tasks[0].due = '2026-10-01'
  await f.service.refresh(); const second = structuredClone(f.native.entries[0])
  assert.equal(first.extra.key, second.extra.key); assert.notEqual(first.id, second.id); assert.notEqual(first.extra.at, second.extra.at)
  assert.ok(f.calls.findIndex(call => call[0] === 'cancel') < f.calls.findIndex(call => call[0] === 'schedule' && call[1][0].id === second.id), 'cancel the old trigger before queuing the new one')
  assert.ok(!f.native.entries.some(entry => entry.id === first.id))
  f.holder.value.tasks[0].title = '虚构的新标题'
  const state = await f.service.refresh()
  assert.equal(state.error, null); assert.equal(state.count, 1); assert.notEqual(f.native.entries[0].id, second.id)
  assert.equal(f.native.entries[0].extra.at, second.extra.at)
  assert.equal(f.native.entries[0].title, '今天截止：虚构的新标题')
})

test('completion and quiet-time changes remove obsolete reservations', async () => {
  const f = fixture({ enabled: true }); await f.service.refresh()
  f.holder.value.preferences.notifications.quietStart = '19:00'; f.holder.value.preferences.notifications.quietEnd = '21:00'
  assert.equal((await f.service.refresh()).count, 0); assert.equal(f.native.entries.length, 0)
  f.holder.value.preferences.notifications.quietEnd = '19:00'; await f.service.refresh()
  f.holder.value.tasks[0].status = 'done'
  assert.equal((await f.service.refresh()).count, 0); assert.equal(f.native.entries.length, 0)
})

test('restarts inspect actual owned pending while preserving other features and colliding ids', async () => {
  const original = fixture({ enabled: true }); await original.service.refresh()
  const foreign = { ...structuredClone(original.native.entries[0]), extra: { owner: 'another-feature' } }
  const f = fixture({ enabled: true, entries: [foreign] })
  assert.equal((await f.service.refresh()).count, 1)
  assert.equal(f.native.entries.length, 2); assert.deepEqual(f.native.entries.find(entry => entry.id === foreign.id), foreign)
  const own = f.native.entries.find(entry => entry.extra.owner !== foreign.extra.owner)
  assert.notEqual(own.id, foreign.id)
  const restarted = fixture({ enabled: true, entries: f.native.entries })
  assert.equal((await restarted.service.status()).count, 1); assert.equal(restarted.of('schedule').length, 0)
  const disabled = await restarted.service.setEnabled(false)
  assert.equal(disabled.enabled, false); assert.equal(disabled.count, 0); assert.deepEqual(restarted.native.entries, [foreign])
})

test('revoked permission cancels owned pending without a permission prompt and reports error until restored', async () => {
  const f = fixture({ enabled: true }); await f.service.refresh()
  f.native.permission = 'denied'
  const state = await f.service.status()
  assert.equal(state.enabled, true); assert.equal(state.authorization, 1); assert.equal(state.count, 0); assert.match(state.error, /允许/u)
  assert.equal(f.native.entries.length, 0); assert.equal(f.of('request').length, 0)
  await assert.rejects(f.service.test(), /允许/u); assert.equal(f.of('request').length, 0)
  f.native.permission = 'granted'; assert.equal((await f.service.refresh()).count, 1)
})

test('native/read failures clear confirmed count and a later refresh recovers', async () => {
  for (const failure of ['pending', 'check', 'cancel', 'schedule', 'snapshot']) {
    const f = fixture({ enabled: true }); await f.service.refresh()
    f.holder.value.tasks[0].due = '2026-10-01'
    if (failure === 'snapshot') f.holder.fail = failure; else f.native.fail = failure
    const failed = await f.service.refresh()
    assert.equal(failed.count, 0, failure); assert.equal(failed.through, null, failure); assert.ok(failed.error, failure)
    f.holder.fail = null; f.native.fail = null
    const recovered = await f.service.refresh()
    assert.equal(recovered.error, null, failure); assert.equal(recovered.count, 1, failure)
    assert.equal(f.native.entries[0].extra.at, buildReminderPlan(f.holder.value, NOW).entries[0].at)
  }
})

test('a cancellation acknowledgement without deletion cannot queue the changed time', async () => {
  const f = fixture({ enabled: true }); await f.service.refresh(); const original = f.native.entries[0].id
  f.native.ignoreCancel = true; f.holder.value.tasks[0].due = '2026-10-01'
  const failed = await f.service.refresh()
  assert.match(failed.error, /旧提醒/u); assert.equal(failed.count, 0); assert.equal(f.of('schedule').length, 1)
  assert.deepEqual(f.native.entries.map(entry => entry.id), [original])
})

test('schedule acknowledgement is insufficient: missing, wrong content, metadata or time fail verification', async () => {
  for (const change of [entry => { entry.title = '' }, entry => { entry.body = '' }, entry => { entry.schedule.at = '2026-10-03T12:00:00+08:00' }, entry => { delete entry.extra }, null]) {
    const f = fixture({ enabled: true })
    if (change) f.native.changeSchedule = change; else f.native.ignoreSchedule = true
    const state = await f.service.refresh()
    assert.ok(state.error); assert.equal(state.count, 0); assert.equal(state.through, null)
  }
})

test('failed initial settings reads retry and failed settings saves never claim enabled', async () => {
  const f = fixture(); f.holder.fail = 'enabled'
  assert.ok((await f.service.status()).error); f.holder.fail = 'save'
  assert.equal((await f.service.setEnabled(true)).enabled, false); assert.deepEqual(f.saves, []); assert.equal(f.of('schedule').length, 0)
  f.holder.fail = null; assert.equal((await f.service.setEnabled(true)).count, 1)
  await assert.rejects(f.service.setEnabled('true'), /开关/u)
})

test('a mutation/foreground burst merges refreshes and uses only the latest snapshot', async () => {
  const f = fixture({ enabled: true })
  const a = f.service.scheduleRefresh(), b = f.service.scheduleRefresh()
  f.holder.value.tasks[0].due = '2026-10-02'
  const c = f.service.scheduleRefresh()
  assert.equal(a, b); assert.equal(b, c)
  const state = await c
  assert.equal(state.count, 1); assert.equal(f.holder.reads, 1); assert.equal(f.of('schedule').length, 1)
  assert.equal(f.native.entries[0].extra.at, buildReminderPlan(f.holder.value, NOW).entries[0].at)
})

test('a slow snapshot cannot publish old time after a newer refresh is requested', async () => {
  const f = fixture({ enabled: true }), started = deferred(), resume = deferred(), old = snapshot()
  f.holder.reader = async () => { f.holder.reader = null; started.resolve(); await resume.promise; return old }
  const first = f.service.refresh(); await started.promise
  f.holder.value.tasks[0].due = '2026-10-02'; const latest = f.service.scheduleRefresh()
  resume.resolve(); const earlier = await first; const state = await latest
  assert.deepEqual(earlier, state, 'a superseded API read waits for the latest verified count and time')
  assert.equal(state.count, 1); assert.equal(f.of('schedule').length, 1)
  assert.equal(f.native.entries[0].extra.at, buildReminderPlan(f.holder.value, NOW).entries[0].at)
})

test('a change during an in-flight native schedule is serialized and its old reservation is removed', async () => {
  const f = fixture({ enabled: true }), gate = { started: deferred(), resume: deferred() }
  f.native.scheduleGate = gate
  const first = f.service.refresh(); await gate.started.promise
  f.holder.value.tasks[0].due = '2026-10-02'; const latest = f.service.scheduleRefresh()
  gate.resume.resolve(); await first; const state = await latest
  assert.equal(state.count, 1); assert.equal(f.native.entries.length, 1); assert.equal(f.of('cancel').length, 1)
  assert.equal(f.native.entries[0].extra.at, buildReminderPlan(f.holder.value, NOW).entries[0].at)
})

test('disabling during a slow snapshot invalidates it and never schedules its reminders', async () => {
  const f = fixture({ enabled: true }), started = deferred(), resume = deferred()
  f.holder.reader = async () => { started.resolve(); await resume.promise; return snapshot() }
  const first = f.service.refresh(); await started.promise
  const disabled = f.service.setEnabled(false); resume.resolve(); await first
  assert.equal((await disabled).enabled, false); assert.equal(f.of('schedule').length, 0); assert.deepEqual(f.saves, [false])
})

test('test checks permission, confirms one owned pending test and disable removes it without deleting others', async () => {
  const f = fixture({ enabled: true }); await f.service.refresh()
  const before = f.native.entries[0]
  assert.match((await f.service.test()).message, /实际送达/u)
  const testEntry = f.native.entries.find(entry => entry.extra.kind === 'test')
  assert.equal(testEntry.extra.at, NOW.getTime() / 1000 + 5); assert.equal(f.of('request').length, 0)
  await f.service.test(); assert.equal(f.native.entries.length, 2)
  assert.equal((await f.service.status()).count, 1); assert.deepEqual(f.native.entries.find(entry => entry.extra.kind === 'plan'), before)
  await f.service.setEnabled(false); assert.equal(f.native.entries.length, 0)
})

test('test scheduling failures reject and never return a success message', async () => {
  const f = fixture({ enabled: true }); await f.service.refresh(); f.native.ignoreSchedule = true
  await assert.rejects(f.service.test(), /未能确认/u)
  f.native.ignoreSchedule = false; assert.match((await f.service.test()).message, /已预约/u)
})

test('dispose stops queued work without deleting confirmed native reminders or running a background loop', async () => {
  const f = fixture({ enabled: true }); await f.service.refresh()
  const count = f.calls.length, pending = structuredClone(f.native.entries)
  const scheduled = f.service.scheduleRefresh(); f.service.dispose(); await scheduled
  await f.service.scheduleRefresh(); await f.service.refresh()
  assert.equal(f.calls.length, count); assert.deepEqual(f.native.entries, pending)
})

test('mobile keeps the shared 30-day/64-entry cap and does not silently drop entries for iOS test capacity', async () => {
  const tasks = Array.from({ length: 70 }, (_, index) => ({ id: `t${index}`, title: `虚构事项 ${index}`, status: 'todo', deletedAt: null, due: '2026-09-30' }))
  const f = fixture({ enabled: true, value: snapshot({ tasks }) })
  const state = await f.service.refresh()
  assert.equal(state.count, 64); assert.equal(state.omitted, 6)
  await assert.rejects(f.service.test(), /上限/u)
  assert.equal(f.native.entries.length, 64); assert.equal(f.of('request').length, 0)
})

test('iOS capacity occupied by another feature is reported as an error without cancelling that feature', async () => {
  const entries = Array.from({ length: 64 }, (_, id) => ({ id, title: '另一个功能的预约', body: '', extra: { owner: 'other-feature' } }))
  const f = fixture({ enabled: true, entries })
  const state = await f.service.refresh()
  assert.equal(state.count, 0); assert.match(state.error, /上限/u)
  assert.deepEqual(f.native.entries, entries); assert.equal(f.of('cancel').length, 0); assert.equal(f.of('schedule').length, 0)
})

test('time passing during permission checking cannot turn a past trigger into an immediate requeue', async () => {
  const f = fixture({ enabled: true }); let checks = 0
  f.native.checkPermissions = async () => { if (++checks === 2) f.holder.time = new Date('2026-09-30T20:01:00+08:00'); return { display: 'granted' } }
  const state = await f.service.refresh()
  assert.equal(state.error, null); assert.equal(state.count, 0); assert.equal(f.of('schedule').length, 0)
})
