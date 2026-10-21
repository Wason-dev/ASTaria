// Synthetic browser regression for the real usePlanner refresh contract.
//
// What this is
//   A test scaffold. It mounts the repository's real src/planner/usePlanner.ts
//   (together with the real src/stores/sameSnapshot.ts and src/stores/migration.ts
//   it depends on) inside a temporary headless Chrome page, and drives the hook
//   through controllable deferred /planner GET and POST gates.
//
//   The only module replaced is src/xixi/api.ts. Every request, planner snapshot
//   and error below is synthetic: the app entry, the dev server, the SQLite API,
//   the vault, the model status and user data never run. Nothing is downloaded,
//   installed or written outside a temporary directory, and no assertion reads
//   hook source text - the behaviour comes from running the real hook.
//
// Layout
//   fixture     page-side harness on window.fixture: deferred api bridge, commit
//               log of {state, loading, saving, error, active}, bounded waits
//               (no sleeps for correctness), mount/unmount helpers.
//   apiStub     the replacement for src/xixi/api.ts (LocalApiError + localApi).
//   page        the synthetic document served to Chrome.
//   scenarios   eight page-side probes. Each returns plain JSON facts; each
//               `check` asserts those facts with node:test/assert on this side.
//   test        one Chrome lifecycle: virtual Vite build -> ephemeral HTTP
//               server -> temporary profile -> CDP -> per-scenario subtests.
//
// Entry point
//   node --test scripts/planner-refresh-ui.test.mjs
//   ASTARIA_CHROME_PATH=<binary> overrides the browser location. A missing local
//   Chrome reports a skip; nothing is downloaded, installed or committed.

import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const chromePath = process.env.ASTARIA_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const delay = ms => new Promise(done => setTimeout(done, ms))

// Page-side harness. It is loaded as a virtual module (see the Vite plugin in
// the test body) and mounts only the real hook. All snapshots and labels below
// are synthetic; the fixture never touches storage, the network or user data.
const fixture = String.raw`
import React, { useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { usePlanner } from './src/planner/usePlanner.ts'
import { LOCAL_DATA_CHANGE } from './src/stores/migration.ts'
import { LocalApiError } from 'virtual:planner-api'

const f = window.fixture = {
  calls: [], commits: [], marks: [], gates: 0, renders: 0, ready: false,
  timeoutMs: 5000, LOCAL_DATA_CHANGE: LOCAL_DATA_CHANGE, ApiError: LocalApiError,
  nextGet: null, nextPost: null, postResult: null, server: null,
  hook: null, lastHook: null, setActive: null, initialActive: true,
}

f.clone = value => structuredClone(value)

// A synthetic planner projection. Only completedFreeTimeSessions is nested.
f.routine = (title = '合成课程') => ({ id: 'routine-1', title: title, kind: 'class', weekdays: [1], start: '08:00', end: '09:30', location: '虚构教室', items: ['合成材料'], enabled: true })
f.snapshot = (revision = 1, overrides = {}) => Object.assign({
  firstWeekMonday: '2026-09-07',
  revision: revision,
  timetableConfirmed: true,
  routines: [f.routine()],
  blocks: [],
  details: {},
  checked: {},
  completedFreeTimeSessions: { '2026-10-12': 'synthetic-session-a' },
}, overrides)

// Explicit deferred gate: a request only settles when the probe releases it.
f.gate = () => {
  const gate = { settled: false, resolve: null, reject: null, promise: null }
  gate.promise = new Promise((resolve, reject) => {
    gate.resolve = value => { gate.settled = true; resolve(f.clone(value)) }
    gate.reject = error => { gate.settled = true; reject(error) }
  })
  f.gates += 1
  return gate
}

// The only replaced module. A GET answers with the current synthetic server
// snapshot unless a gate is queued; a POST needs a gate or an explicit result.
f.api = async (path, body) => {
  const call = { path: path, kind: body === undefined ? 'GET' : 'POST', body: body === undefined ? null : f.clone(body), gated: false }
  f.calls.push(call)
  if (path !== '/planner') throw new Error('unexpected synthetic request: ' + path)
  if (call.kind === 'GET') {
    const gate = f.nextGet; f.nextGet = null
    if (gate) { call.gated = true; return gate.promise }
    return f.clone(f.server)
  }
  const gate = f.nextPost; f.nextPost = null
  if (gate) { call.gated = true; return gate.promise }
  if (!f.postResult) throw new Error('the synthetic write needs a gate or a result')
  return f.clone(f.postResult)
}

// Observation helpers: committed snapshots only, never hook internals.
f.gets = () => f.calls.filter(call => call.kind === 'GET')
f.posts = () => f.calls.filter(call => call.kind === 'POST')
f.view = () => f.commits[f.commits.length - 1] || null
f.mark = name => { f.marks.push({ name: name, commits: f.commits.length, calls: f.calls.length, state: f.view()?.state ?? null }) }
f.between = name => {
  const mark = f.marks.filter(item => item.name === name).pop()
  return { commits: f.commits.slice(mark ? mark.commits : 0), calls: f.calls.slice(mark ? mark.calls : 0), state: mark?.state ?? null }
}
f.distinctStates = commits => {
  const seen = []
  for (const commit of commits) if (commit.state !== null && !seen.includes(commit.state)) seen.push(commit.state)
  return seen.length
}
// Revision of every newly published snapshot, in publish order. Saving/loading
// commits that keep the same snapshot reference are deliberately not counted.
f.publishes = (commits, initialState = null) => {
  const seen = initialState === null ? [] : [initialState], published = []
  for (const commit of commits) {
    if (commit.state === null || seen.includes(commit.state)) continue
    seen.push(commit.state)
    published.push(commit.state.revision)
  }
  return published
}
f.loadingSeen = commits => commits.some(commit => commit.loading === true)
f.savingSeen = commits => commits.some(commit => commit.saving === true)
f.summary = commits => commits.map(commit => ({
  revision: commit.state ? commit.state.revision : null,
  monday: commit.state ? commit.state.firstWeekMonday : null,
  session: commit.state && commit.state.completedFreeTimeSessions ? commit.state.completedFreeTimeSessions['2026-10-12'] : null,
  loading: commit.loading, saving: commit.saving, error: commit.error, active: commit.active,
}))

// Bounded waits replace sleeps: a condition is polled against a deadline and a
// miss fails loudly with the probe label instead of hanging the browser. The
// frame settle races requestAnimationFrame against a timer so a throttled page
// can never stall the suite.
f.tick = () => new Promise(done => setTimeout(done, 0))
f.frame = () => new Promise(done => {
  let settled = false
  const finish = () => { if (!settled) { settled = true; done(null) } }
  requestAnimationFrame(finish)
  setTimeout(finish, 50)
})
f.flush = async (rounds = 4) => {
  for (let round = 0; round < (rounds || 4); round++) { await f.tick(); await f.frame() }
}
f.wait = async (condition, label = 'condition') => {
  const deadline = performance.now() + f.timeoutMs
  while (performance.now() < deadline) {
    if (condition()) return true
    await new Promise(done => setTimeout(done, 4))
  }
  throw new Error('synthetic planner fixture did not settle: ' + label)
}

let root = null
function Harness() {
  const pair = useState(f.initialActive)
  const active = pair[0], setActive = pair[1]
  const planner = usePlanner(active)
  f.hook = planner
  f.setActive = setActive
  f.renders += 1
  useLayoutEffect(() => {
    f.commits.push({ state: planner.state, loading: planner.loading, saving: planner.saving, error: planner.error, active: active })
  })
  return React.createElement('div', { id: 'probe', 'data-active': String(active) })
}

f.mount = async (options = {}) => {
  const settings = options || {}
  f.unmount()
  f.calls = []; f.commits = []; f.marks = []; f.renders = 0
  f.nextGet = settings.getGate ?? null; f.nextPost = null; f.postResult = null
  f.initialActive = settings.active === undefined ? true : settings.active
  f.server = f.clone(settings.server || f.snapshot(1))
  root = createRoot(document.querySelector('#root'))
  root.render(React.createElement(Harness))
  await f.wait(() => Boolean(f.hook), 'harness mount')
  await f.flush()
  return true
}
f.unmount = () => {
  const instance = root
  root = null
  if (!instance) return false
  f.lastHook = f.hook
  f.hook = null
  instance.unmount()
  return true
}

f.ready = true
`

// The synthetic replacement for src/xixi/api.ts. It mirrors the real class
// shape (message + status + name) and forwards every request to the fixture.
const apiStub = String.raw`
export class LocalApiError extends Error {
  constructor(message, status) { super(message); this.name = 'LocalApiError'; this.status = status }
}
export const localApi = (path, body) => window.fixture.api(path, body)
`

const page = '<!doctype html><meta charset="utf-8"><title>synthetic planner refresh</title><div id="root"></div><script type="module" src="/app.js"></script>'

// Eight probes, one per required behaviour. Each probe is an async expression
// evaluated in the page; it returns plain facts and never asserts page-side.
const scenarios = [
  {
    name: 'first load: null state publishes initial loading, then the resolved read',
    detail: 'no cached snapshot -> loading before the read settles -> one published snapshot and loading released',
    code: `(async () => {
      const f = window.fixture
      const gate = f.gate()
      await f.mount({ server: f.snapshot(1), getGate: gate })
      await f.wait(() => f.gets().length >= 1, 'first read issued')
      await f.wait(() => f.view() && f.view().loading === true, 'initial loading published')
      f.mark('loading')
      const open = {
        stateRevision: f.view().state === null ? null : f.view().state.revision,
        loading: f.view().loading, saving: f.view().saving, error: f.view().error,
        gets: f.gets().length, posts: f.posts().length, gated: f.gets()[0].gated, settled: gate.settled,
      }
      gate.resolve(f.snapshot(1))
      await f.wait(() => f.view() && f.view().loading === false && f.view().state !== null, 'first read applied')
      f.mark('applied')
      const closed = {
        revision: f.view().state.revision, loading: f.view().loading, saving: f.view().saving, error: f.view().error,
        gets: f.gets().length, posts: f.posts().length,
        states: f.distinctStates(f.commits),
        loadingSequence: f.commits.map(commit => commit.loading),
        savingSeen: f.savingSeen(f.commits),
        publishedAfterApplied: f.distinctStates(f.between('applied').commits),
        loadingAfterLoading: f.loadingSeen(f.between('loading').commits) ? 'seen' : 'none',
        detail: f.summary(f.commits),
      }
      return { open: open, closed: closed }
    })()`,
    check(seen) {
      assert.equal(seen.open.stateRevision, null, 'the hook starts without a cached snapshot')
      assert.equal(seen.open.loading, true, 'the first read publishes the initial loading state before it resolves')
      assert.equal(seen.open.saving, false, 'a read never reports saving')
      assert.equal(seen.open.error, '', 'a first read starts without an error')
      assert.equal(seen.open.gets, 1, 'mount issues exactly one read')
      assert.equal(seen.open.posts, 0, 'mount issues no write')
      assert.equal(seen.open.gated, true, 'the read is held open by the synthetic gate')
      assert.equal(seen.open.settled, false, 'the held read has not settled yet')
      assert.equal(seen.closed.revision, 1, 'the resolved read publishes the synthetic revision')
      assert.equal(seen.closed.loading, false, 'loading clears when the read resolves')
      assert.equal(seen.closed.error, '', 'a successful read keeps the error empty')
      assert.equal(seen.closed.states, 1, 'the resolved read publishes exactly one snapshot')
      assert.deepEqual(seen.closed.loadingSequence, [false, true, false], 'the mount sequence is idle -> initial loading -> loaded')
      assert.equal(seen.closed.savingSeen, false, 'loading a snapshot never reports saving')
      assert.deepEqual([seen.closed.gets, seen.closed.posts], [1, 0], 'settling the read issues no further request')
      assert.equal(seen.closed.publishedAfterApplied, 0, 'a settled read publishes nothing afterwards')
      assert.equal(seen.closed.loadingAfterLoading, 'none', 'loading is never re-raised after it is released')
    },
  },
  {
    name: 'an equal read republishes no state and never flips loading',
    detail: 'manual refresh, focus and LOCAL_DATA_CHANGE reads that return identical content keep the snapshot identity',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const cached = f.view().state
      const reads = [await f.hook.refresh()]
      await f.wait(() => f.gets().length >= 2, 'manual read issued')
      window.dispatchEvent(new Event('focus'))
      await f.wait(() => f.gets().length >= 3, 'focus read issued')
      window.dispatchEvent(new Event(f.LOCAL_DATA_CHANGE))
      await f.wait(() => f.gets().length >= 4, 'local data change read issued')
      // Two quiet rounds: three equal reads must publish nothing at all.
      await f.flush()
      await f.flush()
      const after = f.between('loaded')
      return {
        reads: reads, gets: f.gets().length, posts: f.posts().length,
        distinct: f.distinctStates(f.commits), stateStable: f.view().state === cached,
        revision: f.view().state.revision, loadingSeen: f.loadingSeen(after.commits),
        saving: f.view().saving, error: f.view().error, commits: after.commits.length,
        loadingSequence: after.commits.map(commit => commit.loading),
      }
    })()`,
    check(seen) {
      assert.deepEqual(seen.reads, [true], 'the explicit refresh resolves true')
      assert.deepEqual([seen.gets, seen.posts], [4, 0], 'three equal reads follow the initial read and no write is issued')
      assert.equal(seen.distinct, 1, 'equal content never republishes a snapshot')
      assert.equal(seen.stateStable, true, 'the published snapshot keeps its identity across equal reads')
      assert.equal(seen.revision, 1, 'the synthetic revision is untouched')
      assert.equal(seen.loadingSeen, false, 'no equal read flips loading back on')
      assert.equal(seen.saving, false, 'reads never report saving')
      assert.equal(seen.error, '', 'equal reads keep the error empty')
    },
  },
  {
    name: 'nested completedFreeTimeSessions changes at the same revision still publish',
    detail: 'the whole projection is compared, so a nested completion-history change and its restore both publish without a revision bump',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const first = f.view().state
      f.server = f.snapshot(1, { completedFreeTimeSessions: { '2026-10-12': 'synthetic-session-b' } })
      const changed = await f.hook.refresh()
      await f.wait(() => f.view().state && f.view().state.completedFreeTimeSessions['2026-10-12'] === 'synthetic-session-b', 'nested change published')
      const afterChange = f.view().state
      f.server = f.snapshot(1, { completedFreeTimeSessions: { '2026-10-12': 'synthetic-session-a' } })
      const restored = await f.hook.refresh()
      await f.wait(() => f.view().state && f.view().state.completedFreeTimeSessions['2026-10-12'] === 'synthetic-session-a', 'nested restore published')
      const afterRestore = f.view().state
      const after = f.between('loaded')
      return {
        reads: [changed, restored],
        publishedChange: afterChange !== first,
        publishedRestore: afterRestore !== afterChange && afterRestore !== first,
        revisions: f.publishes(after.commits, after.state),
        session: afterRestore.completedFreeTimeSessions['2026-10-12'],
        distinct: f.distinctStates(f.commits), gets: f.gets().length, posts: f.posts().length,
        loadingSeen: f.loadingSeen(after.commits), saving: f.view().saving, error: f.view().error,
      }
    })()`,
    check(seen) {
      assert.deepEqual(seen.reads, [true, true], 'both nested reads resolve true')
      assert.equal(seen.publishedChange, true, 'a nested completion-history change at the same revision publishes')
      assert.equal(seen.publishedRestore, true, 'restoring the previous nested value publishes again')
      assert.deepEqual(seen.revisions, [1, 1], 'both published snapshots stay on the same revision')
      assert.equal(seen.session, 'synthetic-session-a', 'the final nested value is the restored one')
      assert.equal(seen.distinct, 3, 'three distinct snapshots are published in total')
      assert.deepEqual([seen.gets, seen.posts], [3, 0], 'each nested read issues exactly one request')
      assert.equal(seen.loadingSeen, false, 'publishing from cache never flips loading on')
      assert.equal(seen.saving, false, 'nested reads never report saving')
      assert.equal(seen.error, '', 'nested reads keep the error empty')
    },
  },
  {
    name: 'a write supersedes an in-flight read',
    detail: 'a GET started before act() must not publish once the POST begins; the write result wins and its coalesced read follows',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const cached = f.view().state
      const staleGate = f.gate()
      f.nextGet = staleGate
      let staleSettled = false, staleValue = null
      f.hook.refresh().then(value => { staleSettled = true; staleValue = value })
      await f.wait(() => f.gets().length >= 2 && f.gets()[1].gated, 'stale read issued')
      const postGate = f.gate()
      f.nextPost = postGate
      const saved = f.snapshot(2, { firstWeekMonday: '2026-09-14' })
      let saveSettled = false, saveValue = null
      f.hook.act({ type: 'set-first-week-monday', date: '2026-09-14' }).then(value => { saveSettled = true; saveValue = value }, () => { saveSettled = true })
      await f.wait(() => f.posts().length >= 1 && f.view().saving === true, 'write issued')
      staleGate.resolve(f.snapshot(9, { timetableConfirmed: false }))
      await f.wait(() => staleSettled === true, 'superseded read settled')
      await f.flush()
      const afterStale = {
        value: staleValue, sameState: f.view().state === cached, revision: f.view().state.revision,
        gets: f.gets().length, posts: f.posts().length, saving: f.view().saving, loading: f.view().loading,
      }
      const mergedGate = f.gate()
      f.nextGet = mergedGate
      f.server = f.clone(saved)
      postGate.resolve(saved)
      await f.wait(() => f.gets().length >= 3 && f.gets()[2].gated && f.view().state && f.view().state.revision === 2 && f.view().saving === false, 'coalesced read issued')
      const afterSave = {
        settled: saveSettled, revision: f.view().state.revision, monday: f.view().state.firstWeekMonday,
        saving: f.view().saving, loading: f.view().loading,
        gets: f.gets().length, posts: f.posts().length,
      }
      mergedGate.resolve(saved)
      await f.wait(() => saveSettled === true, 'write settled after its coalesced read')
      await f.flush()
      const afterMerge = {
        valueRevision: saveValue ? saveValue.revision : null,
        revision: f.view().state.revision, monday: f.view().state.firstWeekMonday,
        gets: f.gets().length, posts: f.posts().length, distinct: f.distinctStates(f.commits),
        stalePublished: f.commits.some(commit => commit.state !== null && commit.state.revision === 9),
        publishedRevisions: f.publishes(f.between('loaded').commits, cached),
      }
      return { afterStale: afterStale, afterSave: afterSave, afterMerge: afterMerge }
    })()`,
    check(seen) {
      assert.equal(seen.afterStale.value, false, 'the superseded read resolves false')
      assert.equal(seen.afterStale.sameState, true, 'the superseded read publishes nothing')
      assert.equal(seen.afterStale.revision, 1, 'the cached revision survives the superseded read')
      assert.deepEqual([seen.afterStale.gets, seen.afterStale.posts], [2, 1], 'the write begins while the read is still in flight')
      assert.equal(seen.afterStale.saving, true, 'the in-flight write reports saving')
      assert.equal(seen.afterStale.loading, false, 'an in-flight write does not raise loading')
      assert.equal(seen.afterSave.settled, false, 'act() settles only after its coalesced read')
      assert.equal(seen.afterSave.revision, 2, 'the write result is published before the coalesced read')
      assert.equal(seen.afterSave.monday, '2026-09-14', 'the published snapshot is the write projection')
      assert.equal(seen.afterSave.saving, false, 'saving is released as soon as the write resolves')
      assert.equal(seen.afterSave.loading, false, 'the cached write never flips loading on')
      assert.deepEqual([seen.afterSave.gets, seen.afterSave.posts], [3, 1], 'exactly one read coalesces after the write')
      assert.equal(seen.afterMerge.valueRevision, 2, 'act() resolves with the write projection')
      assert.equal(seen.afterMerge.revision, 2, 'the coalesced read does not roll the write back')
      assert.equal(seen.afterMerge.monday, '2026-09-14', 'the coalesced read keeps the written value')
      assert.deepEqual([seen.afterMerge.gets, seen.afterMerge.posts], [3, 1], 'no further request follows the coalesced read')
      assert.equal(seen.afterMerge.distinct, 2, 'the equal coalesced read republishes nothing')
      assert.equal(seen.afterMerge.stalePublished, false, 'the invalidated read payload never reaches the state')
      assert.deepEqual(seen.afterMerge.publishedRevisions, [2], 'only the write projection is published after the initial read')
    },
  },
  {
    name: 'a save in flight coalesces reentry, focus, LOCAL_DATA_CHANGE and refresh into one read',
    detail: 'active false/true, focus, LOCAL_DATA_CHANGE and refresh() all queue behind the write; on completion exactly one merged read runs and its response must not roll the save back',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const cached = f.view().state
      const postGate = f.gate()
      f.nextPost = postGate
      const saved = f.snapshot(2, { firstWeekMonday: '2026-09-14' })
      let saveSettled = false, saveValue = null
      f.hook.act({ type: 'set-first-week-monday', date: '2026-09-14' }).then(value => { saveSettled = true; saveValue = value }, () => { saveSettled = true })
      await f.wait(() => f.posts().length >= 1 && f.view().saving === true, 'write issued')
      f.setActive(false)
      await f.wait(() => f.view() && f.view().active === false && f.view().saving === true, 'deactivated while saving')
      f.setActive(true)
      await f.wait(() => f.view() && f.view().active === true && f.view().saving === true, 'reactivated while saving')
      await f.flush()
      let manualSettled = false, manualValue = null
      f.hook.refresh().then(value => { manualSettled = true; manualValue = value })
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event(f.LOCAL_DATA_CHANGE))
      await f.flush()
      const duringSave = {
        gets: f.gets().length, posts: f.posts().length, saving: f.view().saving, loading: f.view().loading,
        manualSettled: manualSettled, saveSettled: saveSettled, active: f.view().active, stateSame: f.view().state === cached,
      }
      const mergedGate = f.gate()
      f.nextGet = mergedGate
      f.server = f.clone(saved)
      postGate.resolve(saved)
      await f.wait(() => f.gets().length >= 2 && f.gets()[1].gated && f.view().state && f.view().state.revision === 2 && f.view().saving === false, 'merged read issued')
      const published = f.view().state
      const afterSaveBeforeMerge = {
        revision: published.revision, monday: published.firstWeekMonday, saving: f.view().saving, loading: f.view().loading,
        gets: f.gets().length, posts: f.posts().length, gated: f.gets()[1].gated,
        saveSettled: saveSettled, manualSettled: manualSettled,
      }
      mergedGate.resolve(saved)
      await f.wait(() => manualSettled === true && saveSettled === true, 'coalesced read released every waiter')
      await f.flush()
      const after = f.between('loaded')
      const afterMerge = {
        revision: f.view().state.revision, monday: f.view().state.firstWeekMonday,
        identityKept: f.view().state === published, distinct: f.distinctStates(f.commits),
        gets: f.gets().length, posts: f.posts().length, manualValue: manualValue,
        valueRevision: saveValue ? saveValue.revision : null,
        loadingSeen: f.loadingSeen(after.commits),
        publishes: f.publishes(after.commits, after.state),
        reverted: f.publishes(after.commits, after.state).indexOf(1) >= 0,
        saving: f.view().saving, error: f.view().error, loading: f.view().loading,
      }
      const later = f.snapshot(3, { firstWeekMonday: '2026-09-14', checked: { '2026-10-13': ['synthetic-item'] } })
      const laterGate = f.gate()
      f.nextGet = laterGate
      f.server = f.clone(later)
      let laterSettled = false, laterValue = null
      f.hook.refresh().then(value => { laterSettled = true; laterValue = value })
      await f.wait(() => f.gets().length >= 3 && f.gets()[2].gated, 'later read issued')
      laterGate.resolve(later)
      await f.wait(() => laterSettled === true && f.view().state && f.view().state.revision === 3, 'later read applied')
      await f.flush()
      const afterLaterRead = {
        read: laterValue, revision: f.view().state.revision, monday: f.view().state.firstWeekMonday,
        gets: f.gets().length, posts: f.posts().length, loading: f.view().loading, error: f.view().error,
      }
      return { duringSave: duringSave, afterSaveBeforeMerge: afterSaveBeforeMerge, afterMerge: afterMerge, afterLaterRead: afterLaterRead }
    })()`,
    check(seen) {
      assert.equal(seen.duringSave.gets, 1, 'no concurrent read is issued while the write is in flight')
      assert.equal(seen.duringSave.posts, 1, 'only the held write is in flight')
      assert.equal(seen.duringSave.saving, true, 'the hook reports saving throughout')
      assert.equal(seen.duringSave.loading, false, 'a cached save never raises loading')
      assert.equal(seen.duringSave.manualSettled, false, 'a manual refresh stays queued behind the write')
      assert.equal(seen.duringSave.saveSettled, false, 'the write is still held open')
      assert.equal(seen.duringSave.active, true, 'the hook is active again while the write is in flight')
      assert.equal(seen.duringSave.stateSame, true, 'queued entry points publish nothing before the write resolves')
      assert.equal(seen.afterSaveBeforeMerge.revision, 2, 'the write projection is published when the write resolves')
      assert.equal(seen.afterSaveBeforeMerge.monday, '2026-09-14', 'the write projection carries the written value')
      assert.equal(seen.afterSaveBeforeMerge.saving, false, 'saving is released before the coalesced read')
      assert.equal(seen.afterSaveBeforeMerge.loading, false, 'the coalesced read does not raise loading')
      assert.equal(seen.afterSaveBeforeMerge.gated, true, 'only one coalesced read is issued and it is held open')
      assert.deepEqual([seen.afterSaveBeforeMerge.gets, seen.afterSaveBeforeMerge.posts], [2, 1], 'reactivation, focus, the change event, the manual refresh and the save notification collapse into one read')
      assert.equal(seen.afterSaveBeforeMerge.saveSettled, false, 'act() waits for the coalesced read')
      assert.equal(seen.afterSaveBeforeMerge.manualSettled, false, 'the queued manual refresh waits for the coalesced read')
      assert.equal(seen.afterMerge.revision, 2, 'the merged response does not roll the save back')
      assert.equal(seen.afterMerge.monday, '2026-09-14', 'the merged response keeps the written value')
      assert.equal(seen.afterMerge.identityKept, true, 'an equal merged response keeps the published identity')
      assert.equal(seen.afterMerge.distinct, 2, 'the save publishes once and the merged equal read publishes nothing')
      assert.deepEqual([seen.afterMerge.gets, seen.afterMerge.posts], [2, 1], 'the coalesced read is the only follow-up request')
      assert.equal(seen.afterMerge.manualValue, true, 'the queued refresh resolves true once the merged read lands')
      assert.equal(seen.afterMerge.valueRevision, 2, 'act() resolves with the write projection')
      assert.equal(seen.afterMerge.loadingSeen, false, 'no queued entry point ever published loading')
      assert.deepEqual(seen.afterMerge.publishes, [2], 'the save is the only snapshot published after the initial read')
      assert.equal(seen.afterMerge.reverted, false, 'no commit after the write falls back to the pre-save revision')
      assert.equal(seen.afterMerge.saving, false, 'the hook is idle after the merged read')
      assert.equal(seen.afterMerge.error, '', 'the save leaves the error empty')
      assert.equal(seen.afterLaterRead.read, true, 'a later read still resolves true')
      assert.equal(seen.afterLaterRead.revision, 3, 'a newer response is applied after the save')
      assert.equal(seen.afterLaterRead.monday, '2026-09-14', 'the newer response keeps the saved value')
      assert.equal(seen.afterLaterRead.gets, 3, 'the later read is a single new request')
      assert.equal(seen.afterLaterRead.error, '', 'the later read keeps the error empty')
    },
  },
  {
    name: 'a failed save releases saving, recovers with one read, rejects the original error and never deadlocks',
    detail: 'a 409 conflict must reject with the same error instance after one recovery read, keep the cached snapshot and leave the hook usable',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const cached = f.view().state
      const postGate = f.gate()
      f.nextPost = postGate
      const conflict = new f.ApiError('日程已在其他窗口更新，请重新读取', 409)
      let saveSettled = false, saveValue = null, saveError = null
      f.hook.act({ type: 'save-details', taskId: 'synthetic-task', details: { items: [], preparation: '合成准备', needsSubmission: false, submittedAt: null } }, 1)
        .then(value => { saveSettled = true; saveValue = value }, error => { saveSettled = true; saveError = error })
      await f.wait(() => f.posts().length >= 1 && f.view().saving === true, 'write issued')
      let queuedSettled = false, queuedValue = null
      f.hook.refresh().then(value => { queuedSettled = true; queuedValue = value })
      await f.flush()
      const duringSave = {
        gets: f.gets().length, posts: f.posts().length, saving: f.view().saving, loading: f.view().loading,
        queuedSettled: queuedSettled, settled: saveSettled, stateSame: f.view().state === cached,
      }
      const recovery = f.snapshot(3, { checked: { '2026-10-13': ['synthetic-item'] } })
      const recoveryGate = f.gate()
      f.nextGet = recoveryGate
      f.server = f.clone(recovery)
      postGate.reject(conflict)
      await f.wait(() => f.gets().length >= 2 && f.gets()[1].gated && f.view().saving === false, 'recovery read issued after saving was released')
      const duringRecovery = {
        saving: f.view().saving, loading: f.view().loading, error: f.view().error,
        settled: saveSettled, queuedSettled: queuedSettled, gets: f.gets().length, posts: f.posts().length,
        stateSame: f.view().state === cached, gated: f.gets()[1].gated,
      }
      recoveryGate.resolve(recovery)
      await f.wait(() => saveSettled === true && queuedSettled === true, 'failure surfaced after the recovery read')
      await f.flush()
      const after = f.between('loaded')
      const afterRecovery = {
        rejectedWithOriginal: saveError === conflict,
        message: saveError ? saveError.message : null,
        status: saveError ? saveError.status : null,
        name: saveError ? saveError.name : null,
        resolved: saveValue !== null, queuedValue: queuedValue,
        revision: f.view().state.revision, checked: f.view().state.checked['2026-10-13'] ? f.view().state.checked['2026-10-13'][0] : null,
        error: f.view().error, saving: f.view().saving, loading: f.view().loading,
        gets: f.gets().length, posts: f.posts().length,
        stateLost: after.commits.some(commit => commit.state === null),
        loadingSeen: f.loadingSeen(after.commits),
      }
      const secondGate = f.gate()
      f.nextPost = secondGate
      const second = f.snapshot(4, { checked: { '2026-10-13': ['synthetic-item', 'synthetic-extra'] } })
      f.server = f.clone(second)
      let secondSettled = false
      f.hook.act({ type: 'check-item', date: '2026-10-13', key: 'synthetic-extra', checked: true })
        .then(() => { secondSettled = true }, () => { secondSettled = true })
      await f.wait(() => f.posts().length >= 2, 'a later write is accepted')
      secondGate.resolve(second)
      await f.wait(() => secondSettled === true && f.view().state.revision === 4, 'later write applied')
      await f.flush()
      const afterSecond = {
        gets: f.gets().length, posts: f.posts().length, revision: f.view().state.revision,
        checks: f.view().state.checked['2026-10-13'].length, saving: f.view().saving, error: f.view().error, loading: f.view().loading,
      }
      return { duringSave: duringSave, duringRecovery: duringRecovery, afterRecovery: afterRecovery, afterSecond: afterSecond }
    })()`,
    check(seen) {
      assert.deepEqual([seen.duringSave.gets, seen.duringSave.posts], [1, 1], 'the held write issues no concurrent read')
      assert.equal(seen.duringSave.saving, true, 'the held write reports saving')
      assert.equal(seen.duringSave.queuedSettled, false, 'a refresh queued behind the write stays pending')
      assert.equal(seen.duringSave.settled, false, 'the failing write has not settled while it is held')
      assert.equal(seen.duringSave.stateSame, true, 'a held write keeps the cached snapshot')
      assert.equal(seen.duringRecovery.gets, 2, 'exactly one recovery read follows the failure')
      assert.equal(seen.duringRecovery.gated, true, 'the recovery read is held open')
      assert.equal(seen.duringRecovery.saving, false, 'saving is released before the recovery read')
      assert.equal(seen.duringRecovery.loading, false, 'recovery reads with a cached snapshot never raise loading')
      assert.equal(seen.duringRecovery.error, '', 'the failed write rejects to its caller instead of publishing an error')
      assert.equal(seen.duringRecovery.settled, false, 'the rejection waits for the recovery read')
      assert.equal(seen.duringRecovery.queuedSettled, false, 'the queued refresh joins the single recovery read')
      assert.equal(seen.duringRecovery.posts, 1, 'the failure issues no retry write')
      assert.equal(seen.duringRecovery.stateSame, true, 'the failed write does not clear the cached snapshot')
      assert.equal(seen.afterRecovery.rejectedWithOriginal, true, 'act() rejects with the original error instance')
      assert.equal(seen.afterRecovery.message, '日程已在其他窗口更新，请重新读取', 'the original message is preserved')
      assert.equal(seen.afterRecovery.status, 409, 'the original status is preserved')
      assert.equal(seen.afterRecovery.name, 'LocalApiError', 'the original error type is preserved')
      assert.equal(seen.afterRecovery.resolved, false, 'the failed write never resolves')
      assert.equal(seen.afterRecovery.queuedValue, true, 'the queued refresh resolves true from the recovery read')
      assert.equal(seen.afterRecovery.revision, 3, 'the recovery read publishes the authoritative snapshot')
      assert.equal(seen.afterRecovery.checked, 'synthetic-item', 'the recovery projection is the published one')
      assert.equal(seen.afterRecovery.error, '', 'a successful recovery keeps the error empty')
      assert.equal(seen.afterRecovery.saving, false, 'saving stays released after the failure')
      assert.equal(seen.afterRecovery.loading, false, 'recovery leaves loading released')
      assert.deepEqual([seen.afterRecovery.gets, seen.afterRecovery.posts], [2, 1], 'the failure costs exactly one recovery read')
      assert.equal(seen.afterRecovery.stateLost, false, 'no commit drops the cached snapshot during the failure')
      assert.equal(seen.afterRecovery.loadingSeen, false, 'the failed save never flips loading on')
      assert.equal(seen.afterSecond.posts, 2, 'a later write is accepted, so the hook is not deadlocked')
      assert.equal(seen.afterSecond.revision, 4, 'the later write publishes its projection')
      assert.equal(seen.afterSecond.checks, 2, 'the later write projection reaches the state')
      assert.equal(seen.afterSecond.gets, 3, 'the later write coalesces exactly one follow-up read')
      assert.equal(seen.afterSecond.saving, false, 'the hook is idle after the later write')
      assert.equal(seen.afterSecond.error, '', 'the later write keeps the error empty')
    },
  },
  {
    name: 'deactivation invalidates a pending read and reactivation reads the new data',
    detail: 'an in-flight GET resolved after active=false must publish nothing; active=true then issues a fresh read whose response wins',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const cached = f.view().state
      const staleGate = f.gate()
      f.nextGet = staleGate
      let staleSettled = false, staleValue = null
      f.hook.refresh().then(value => { staleSettled = true; staleValue = value })
      await f.wait(() => f.gets().length >= 2 && f.gets()[1].gated, 'in-flight read issued')
      f.setActive(false)
      await f.wait(() => f.view() && f.view().active === false, 'deactivated')
      await f.flush()
      const deactivated = {
        gets: f.gets().length, loading: f.view().loading, stateSame: f.view().state === cached,
        revision: f.view().state.revision, active: f.view().active,
      }
      staleGate.resolve(f.snapshot(7, { timetableConfirmed: false }))
      await f.wait(() => staleSettled === true, 'invalidated read settled')
      await f.flush()
      const afterStale = {
        value: staleValue, stateSame: f.view().state === cached, revision: f.view().state.revision,
        gets: f.gets().length, loading: f.view().loading, stalePublished: f.commits.some(commit => commit.state !== null && commit.state.revision === 7),
      }
      const fresh = f.snapshot(4, { timetableConfirmed: false, routines: [f.routine('合成新课')] })
      const reentryGate = f.gate()
      f.nextGet = reentryGate
      f.server = f.clone(fresh)
      f.setActive(true)
      await f.wait(() => f.gets().length >= 3 && f.gets()[2].gated, 'reentry read issued')
      const duringReentry = {
        active: f.view().active, loading: f.view().loading, gets: f.gets().length, stateSame: f.view().state === cached,
      }
      reentryGate.resolve(fresh)
      await f.wait(() => f.view().state && f.view().state.revision === 4, 'reentry read applied')
      await f.flush()
      const afterReentry = {
        revision: f.view().state.revision, confirmed: f.view().state.timetableConfirmed,
        title: f.view().state.routines[0].title, distinct: f.distinctStates(f.commits),
        gets: f.gets().length, posts: f.posts().length, loading: f.view().loading, error: f.view().error,
        stalePublished: f.commits.some(commit => commit.state !== null && commit.state.revision === 7),
      }
      return { deactivated: deactivated, afterStale: afterStale, duringReentry: duringReentry, afterReentry: afterReentry }
    })()`,
    check(seen) {
      assert.equal(seen.deactivated.active, false, 'the harness is deactivated while the read is in flight')
      assert.equal(seen.deactivated.gets, 2, 'deactivation issues no new read')
      assert.equal(seen.deactivated.loading, false, 'deactivation leaves loading released')
      assert.equal(seen.deactivated.stateSame, true, 'deactivation keeps the cached snapshot')
      assert.equal(seen.afterStale.value, false, 'the invalidated read resolves false')
      assert.equal(seen.afterStale.stateSame, true, 'the invalidated read publishes nothing')
      assert.equal(seen.afterStale.revision, 1, 'the cached revision survives the invalidated read')
      assert.equal(seen.afterStale.gets, 2, 'the invalidated read issues no follow-up request')
      assert.equal(seen.afterStale.stalePublished, false, 'the invalidated payload never reaches the state')
      assert.equal(seen.duringReentry.active, true, 'reactivation re-registers the hook')
      assert.equal(seen.duringReentry.gets, 3, 'reactivation issues exactly one fresh read')
      assert.equal(seen.duringReentry.stateSame, true, 'the fresh read has not published while it is held open')
      assert.equal(seen.afterReentry.revision, 4, 'the reentry read publishes the new data')
      assert.equal(seen.afterReentry.confirmed, false, 'the reentry projection wins over the cached snapshot')
      assert.equal(seen.afterReentry.title, '合成新课', 'the reentry projection carries its own content')
      assert.equal(seen.afterReentry.distinct, 2, 'only the initial and reentry snapshots are published')
      assert.equal(seen.afterReentry.gets, 3, 'the reentry read is a single request')
      assert.equal(seen.afterReentry.stalePublished, false, 'the invalidated payload stays out of the state')
      assert.equal(seen.afterReentry.loading, false, 'reentry reads with a cached snapshot never raise loading')
      assert.equal(seen.afterReentry.error, '', 'the reentry read keeps the error empty')
    },
  },
  {
    name: 'unmount releases queued refresh waiters and publishes no invalidated state',
    detail: 'unmounting during a held write resolves the queued refresh with false, keeps every later response out of the state and issues no read afterwards',
    code: `(async () => {
      const f = window.fixture
      await f.mount({ server: f.snapshot(1) })
      await f.wait(() => f.view() && f.view().state !== null, 'initial read')
      f.mark('loaded')
      const cached = f.view().state
      const postGate = f.gate()
      f.nextPost = postGate
      let saveSettled = false, saveValue = null
      f.hook.act({ type: 'import-routines', routines: [f.routine('合成导入')] })
        .then(value => { saveSettled = true; saveValue = value }, () => { saveSettled = true })
      await f.wait(() => f.posts().length >= 1 && f.view().saving === true, 'write issued')
      let queuedSettled = false, queuedValue = null
      f.hook.refresh().then(value => { queuedSettled = true; queuedValue = value })
      await f.flush()
      const duringSave = {
        gets: f.gets().length, posts: f.posts().length, saving: f.view().saving,
        queuedSettled: queuedSettled, settled: saveSettled, commits: f.commits.length,
      }
      const commitsBeforeUnmount = f.commits.length
      f.unmount()
      await f.wait(() => queuedSettled === true, 'unmount released the queued refresh')
      const afterUnmount = {
        queuedValue: queuedValue, gets: f.gets().length, posts: f.posts().length,
        commits: f.commits.length, saving: f.view().saving, stateSame: f.view().state === cached,
        settled: saveSettled,
      }
      const fresh = f.snapshot(2, { routines: [f.routine('合成导入')] })
      f.server = f.clone(fresh)
      postGate.resolve(fresh)
      await f.wait(() => saveSettled === true, 'write settled after unmount')
      await f.flush()
      const afterRelease = {
        gets: f.gets().length, posts: f.posts().length, commits: f.commits.length,
        stateSame: f.view().state === cached, saving: f.view().saving,
        valueRevision: saveValue ? saveValue.revision : null, queuedValue: queuedValue,
      }
      const late = await f.lastHook.refresh()
      await f.flush()
      const afterLate = { value: late, gets: f.gets().length, commits: f.commits.length, saving: f.view().saving }
      return {
        duringSave: duringSave, commitsBeforeUnmount: commitsBeforeUnmount,
        afterUnmount: afterUnmount, afterRelease: afterRelease, afterLate: afterLate,
      }
    })()`,
    check(seen) {
      assert.deepEqual([seen.duringSave.gets, seen.duringSave.posts], [1, 1], 'the held write issues no read')
      assert.equal(seen.duringSave.saving, true, 'the held write reports saving before unmount')
      assert.equal(seen.duringSave.queuedSettled, false, 'the queued refresh waits behind the write')
      assert.equal(seen.duringSave.settled, false, 'the write is still held open before unmount')
      assert.equal(seen.afterUnmount.queuedValue, false, 'unmount releases the queued refresh with false')
      assert.equal(seen.afterUnmount.gets, 1, 'unmount issues no new read')
      assert.equal(seen.afterUnmount.posts, 1, 'unmount issues no new write')
      assert.equal(seen.afterUnmount.commits, seen.commitsBeforeUnmount, 'unmount publishes no further state')
      assert.equal(seen.afterUnmount.saving, true, 'saving is frozen by the guard instead of publishing after unmount')
      assert.equal(seen.afterUnmount.stateSame, true, 'the unmounted hook keeps its last published snapshot')
      assert.equal(seen.afterUnmount.settled, false, 'the held write is still open right after unmount')
      assert.equal(seen.afterRelease.gets, 1, 'a write resolving after unmount issues no recovery read')
      assert.equal(seen.afterRelease.posts, 1, 'a write resolving after unmount issues no follow-up write')
      assert.equal(seen.afterRelease.commits, seen.commitsBeforeUnmount, 'a write resolving after unmount publishes nothing')
      assert.equal(seen.afterRelease.stateSame, true, 'the invalidated write result never reaches the state')
      assert.equal(seen.afterRelease.saving, true, 'the frozen saving flag is not published after unmount')
      assert.equal(seen.afterRelease.valueRevision, 2, 'act() still resolves with the write projection')
      assert.equal(seen.afterRelease.queuedValue, false, 'the released waiter keeps the false refresh result')
      assert.equal(seen.afterLate.value, false, 'a refresh after unmount resolves false immediately')
      assert.equal(seen.afterLate.gets, 1, 'a refresh after unmount issues no read')
      assert.equal(seen.afterLate.commits, seen.commitsBeforeUnmount, 'a refresh after unmount publishes nothing')
    },
  },
]

test('synthetic browser: planner refresh, coalescing, invalidation and unmount contract', { timeout: 120000 }, async t => {
  try { await access(chromePath) } catch { t.skip('Local Chrome is unavailable; the synthetic planner refresh test is skipped'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-planner-refresh-'))
  let chrome, socket, server
  t.after(async () => {
    socket?.close()
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(done => chrome.once('close', done))
      chrome.kill(); await Promise.race([exited, delay(2000)])
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
    }
    if (server) await new Promise(done => server.close(done))
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  // Virtual fixture: the real hook, the real comparator and the real change
  // event stay in the graph; only the local API module is replaced. Recording
  // which files were loaded proves the test exercises the repository code
  // instead of a copy, without asserting on hook source text.
  const fixtureId = join(project, '__synthetic-planner-refresh__.tsx')
  const realModules = []
  let stubbedApi = 0
  const output = await build({
    configFile: false, root: project, publicDir: false, cacheDir: join(temporary, 'vite-cache'), logLevel: 'error',
    define: { 'import.meta.env.MODE': '"test"', 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false' },
    plugins: [react(), {
      name: 'synthetic-planner-api', enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'virtual:planner-fixture') return fixtureId
        if (id === 'virtual:planner-api') return '\0synthetic-planner-api'
        if (/(?:^|\/)api(?:\.ts)?$/u.test(id) && importer?.includes('/src/')) return '\0synthetic-planner-api'
        return null
      },
      load(id) {
        if (id === fixtureId) return fixture
        if (id === '\0synthetic-planner-api') { stubbedApi += 1; return apiStub }
        const path = id.replace(/\\/gu, '/').split('?')[0].split('#')[0]
        if (path.endsWith('/src/planner/usePlanner.ts')) realModules.push('usePlanner')
        if (path.endsWith('/src/stores/sameSnapshot.ts')) realModules.push('sameSnapshot')
        if (path.endsWith('/src/stores/migration.ts')) realModules.push('migration')
        if (path.endsWith('/src/xixi/api.ts')) throw new Error('the real local API module must not enter the synthetic planner bundle')
        return null
      },
    }],
    build: {
      write: false, outDir: temporary, emptyOutDir: false, minify: false, cssCodeSplit: false, assetsInlineLimit: 10000000,
      rollupOptions: { input: 'virtual:planner-fixture', output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' } },
    },
  })
  assert.ok(stubbedApi >= 1, 'the synthetic local API replaced the real module')
  assert.ok(realModules.includes('usePlanner'), 'the real src/planner/usePlanner.ts is part of the synthetic bundle')
  assert.ok(realModules.includes('sameSnapshot'), 'the real src/stores/sameSnapshot.ts is part of the synthetic bundle')
  t.diagnostic(`bundled repository modules: ${realModules.join(', ')}`)

  const assets = new Map((Array.isArray(output) ? output : [output]).flatMap(result => result.output).map(file => [`/${file.fileName}`, file.type === 'chunk' ? file.code : file.source]))
  server = createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end(page); return }
    const asset = assets.get(request.url)
    if (!asset) { response.statusCode = 404; response.end(); return }
    response.setHeader('Content-Type', 'text/javascript'); response.end(asset)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))

  const profile = join(temporary, 'profile')
  chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update'], { stdio: 'ignore' })
  let port
  for (let attempt = 0; attempt < 120; attempt++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await delay(50) } }
  assert.ok(port, 'Chrome opens a temporary debug profile')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let id = 0; const waiting = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (!message.id) return
    const item = waiting.get(message.id); waiting.delete(message.id)
    if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result)
  })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; waiting.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  await command('Page.enable'); await command('Runtime.enable')
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
  for (let attempt = 0; attempt < 120 && !await evaluate('Boolean(window.fixture?.ready)'); attempt++) await delay(50)
  assert.equal(await evaluate('Boolean(window.fixture?.ready)'), true, 'the synthetic planner fixture boots')

  for (const scenario of scenarios) {
    await t.test(scenario.name, async sub => {
      const seen = await evaluate(scenario.code)
      try { scenario.check(seen) } catch (error) {
        // The observation is synthetic planner data only; it makes a failing
        // acceptance run diagnosable without rerunning the browser by hand.
        sub.diagnostic(`observation: ${JSON.stringify(seen)}`)
        throw error
      }
      sub.diagnostic(scenario.detail)
    })
  }
  t.diagnostic(`${scenarios.length} planner refresh scenarios ran against the real hook in a temporary headless Chrome`)
})
