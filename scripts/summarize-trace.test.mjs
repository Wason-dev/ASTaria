/**
 * ASTARIA-P0-TRACE-0915 — acceptance tests for scripts/summarize-trace.mjs
 *
 * Run: node --test scripts/summarize-trace.test.mjs
 *
 * Every fixture below is hand-made and small; a fixture is the minimum set of trace
 * events needed to pin one behaviour. Fixtures are passed to summarizeTrace() directly
 * (no disk) except in the CLI tests, which write throwaway fixtures into a temp dir.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import {
  CR_RENDERER_MAIN_THREAD_NAME,
  FRAME_EVENT_NAME,
  LONG_TASK_EVENT_NAME,
  LONG_TASK_THRESHOLD_US,
  SCHEMA,
  USAGE,
  TraceFormatError,
  commandLineFromArgv,
  extractTraceEvents,
  parseTraceText,
  percentile,
  roundTo,
  summarizeTrace,
  usToMs,
} from './summarize-trace.mjs'

const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'summarize-trace.mjs')

/* ----------------------------------------------------------- fixture helpers */

const RENDERER_PID = 100
const RENDERER_TID = 200

function threadNameEvent(pid, tid, name = CR_RENDERER_MAIN_THREAD_NAME) {
  return { name: 'thread_name', ph: 'M', pid, tid, args: { name } }
}

function processNameEvent(pid, name = 'Renderer') {
  return { name: 'process_name', ph: 'M', pid, tid: 0, args: { name } }
}

function runTask(pid, tid, ts, dur) {
  return { name: LONG_TASK_EVENT_NAME, cat: 'toplevel', ph: 'X', ts, dur, pid, tid }
}

function frame(pid, tid, ts, dur = 500) {
  return { name: FRAME_EVENT_NAME, cat: 'devtools.timeline', ph: 'X', ts, dur, pid, tid }
}

function threadByKey(summary, key) {
  const found = summary.threads.find((thread) => thread.key === key)
  assert.ok(found, `expected an analysed thread with key ${key}; got ${summary.threads.map((t) => t.key).join(', ') || '(none)'}`)
  return found
}

function closeTo(actual, expected, epsilon = 0.002, label = 'value') {
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected} ± ${epsilon}, got ${actual}`,
  )
}

function withTempDir(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------- input shapes */

test('accepts both {"traceEvents":[...]} and a bare array', () => {
  const events = [threadNameEvent(RENDERER_PID, RENDERER_TID)]

  const wrapped = extractTraceEvents({ traceEvents: events })
  assert.equal(wrapped.format, 'traceEvents')
  assert.deepEqual(wrapped.events, events)

  const bare = extractTraceEvents(events)
  assert.equal(bare.format, 'bare-array')
  assert.deepEqual(bare.events, events)

  const fromBareArray = summarizeTrace(events)
  assert.equal(fromBareArray.input.format, 'bare-array')
  assert.equal(fromBareArray.selection.matchedThreadCount, 1)

  assert.throws(() => extractTraceEvents({ foo: 1 }), TraceFormatError)
  assert.throws(() => extractTraceEvents({ traceEvents: 'nope' }), TraceFormatError)
  assert.throws(() => extractTraceEvents(42), TraceFormatError)
  assert.throws(() => parseTraceText('{not json'), TraceFormatError)
})

test('parses trace text with a UTF-8 BOM', () => {
  const parsed = parseTraceText('\uFEFF{"traceEvents":[]}')
  assert.deepEqual(parsed, { traceEvents: [] })
})

/* ------------------------------------------- microseconds / milliseconds */

test('converts microsecond timestamps and durations to milliseconds', () => {
  const summary = summarizeTrace({
    traceEvents: [
      processNameEvent(RENDERER_PID),
      threadNameEvent(RENDERER_PID, RENDERER_TID),
      runTask(RENDERER_PID, RENDERER_TID, 1_000_000, 50_001), // 1 s -> 1000 ms, 50.001 ms
      frame(RENDERER_PID, RENDERER_TID, 2_000_000, 1_000),
      frame(RENDERER_PID, RENDERER_TID, 2_016_000, 1_000), // 16 000 us interval -> 16 ms
    ],
  })

  // unit contract
  assert.equal(summary.units.sourceTimeUnit, 'microseconds')
  assert.equal(summary.units.sourceTimeUnitSymbol, 'us')
  assert.equal(summary.units.derivedTimeUnit, 'milliseconds')
  assert.equal(summary.units.conversion, '1 ms = 1000 us (ms = us / 1000)')

  // sampling duration, in us / ms / s, over min(ts) .. max(ts + dur)
  assert.equal(summary.sampling.windowStartUs, 1_000_000)
  assert.equal(summary.sampling.windowEndUs, 2_017_000)
  assert.equal(summary.sampling.durationUs, 1_017_000)
  assert.equal(summary.sampling.durationMs, 1017)
  assert.equal(summary.sampling.durationSeconds, 1.017)
  assert.equal(summary.sampling.unit, 'microseconds')

  // per-thread sampling window
  const thread = threadByKey(summary, `${RENDERER_PID}:${RENDERER_TID}`)
  assert.equal(thread.sampling.windowStartUs, 1_000_000)
  assert.equal(thread.sampling.windowEndUs, 2_017_000)
  assert.equal(thread.sampling.durationUs, 1_017_000)
  assert.equal(thread.sampling.durationMs, 1017)

  // long task conversion
  assert.equal(thread.longTasks.count, 1)
  assert.equal(thread.longTasks.thresholdUs, 50_000)
  assert.equal(thread.longTasks.thresholdMs, 50)
  assert.equal(thread.longTasks.tasks[0].tsUs, 1_000_000)
  assert.equal(thread.longTasks.tasks[0].tsMs, 1000)
  assert.equal(thread.longTasks.tasks[0].durUs, 50_001)
  assert.equal(thread.longTasks.tasks[0].durMs, 50.001)
  assert.equal(thread.longTasks.tasks[0].overThresholdByUs, 1)
  assert.equal(thread.longTasks.totalDurMs, 50.001)
  assert.equal(thread.longTasks.maxDurMs, 50.001)

  // frame interval conversion
  assert.deepEqual(thread.animationFrames.intervalsUs, [16_000])
  assert.equal(thread.animationFrames.intervalStatsMs.avg, 16)
  assert.equal(thread.animationFrames.intervalStatsUs.avg, 16_000)
  assert.equal(thread.animationFrames.frameSamplingSpanUs, 16_000)
  assert.equal(thread.animationFrames.frameSamplingSpanMs, 16)
  assert.equal(thread.animationFrames.frameSamplingSpanSeconds, 0.016)
  assert.equal(thread.animationFrames.fps.fromMeanInterval, 62.5)
  assert.equal(thread.animationFrames.fps.fromSamplingSpan, 62.5)

  // pure unit helpers
  assert.equal(usToMs(1), 0.001)
  assert.equal(usToMs(50_000), 50)
  assert.equal(usToMs(1_000_000), 1000)
  assert.equal(roundTo(28.893_666_666_6, 3), 28.894)
})

/* ------------------------------------------------- thread separation rules */

test('separates threads by pid+tid and ignores non-CrRendererMain threads', () => {
  const summary = summarizeTrace({
    traceEvents: [
      processNameEvent(1),
      threadNameEvent(1, 10),
      threadNameEvent(1, 11),
      threadNameEvent(1, 12, 'Chrome_ChildIOThread'),
      threadNameEvent(2, 10), // same tid, different pid -> a different thread
      threadNameEvent(2, 11, 'Compositor'),

      runTask(1, 10, 100_000, 60_000), // long (thread 1:10)
      frame(1, 10, 1_000_000),
      frame(1, 10, 1_016_000), // interval 16 000 us

      runTask(1, 11, 200_000, 70_000), // long (thread 1:11)
      frame(1, 11, 2_000_000),
      frame(1, 11, 2_050_000),
      frame(1, 11, 2_100_000), // intervals 50 000 / 50 000 us

      runTask(1, 12, 300_000, 900_000), // NOT CrRendererMain -> ignored
      frame(1, 12, 3_000_000),
      frame(1, 12, 3_500_000),

      runTask(2, 10, 400_000, 80_000), // long (thread 2:10)
      frame(2, 10, 4_000_000),
      frame(2, 10, 4_033_000), // interval 33 000 us

      runTask(2, 11, 500_000, 55_000), // NOT CrRendererMain -> ignored
      frame(2, 11, 5_000_000),
    ],
  })

  assert.equal(summary.selection.matchedThreadCount, 3)
  assert.deepEqual(summary.selection.matchedThreadKeys, ['1:10', '1:11', '2:10'])
  assert.equal(summary.dataAvailability.crRendererMainThreadFound, true)

  const t110 = threadByKey(summary, '1:10')
  const t111 = threadByKey(summary, '1:11')
  const t210 = threadByKey(summary, '2:10')

  // each thread only sees its own events
  assert.equal(t110.eventCount, 4) // thread_name + RunTask + 2 frames
  assert.equal(t111.eventCount, 5)
  assert.equal(t210.eventCount, 4)
  assert.equal(t110.threadName, CR_RENDERER_MAIN_THREAD_NAME)
  assert.equal(t110.processName, 'Renderer')

  // ... and only its own frame series (no cross-thread pooling)
  assert.deepEqual(t110.animationFrames.intervalsUs, [16_000])
  assert.deepEqual(t111.animationFrames.intervalsUs, [50_000, 50_000])
  assert.deepEqual(t210.animationFrames.intervalsUs, [33_000])
  assert.equal(t110.animationFrames.intervalStatsMs.avg, 16)
  assert.equal(t111.animationFrames.intervalStatsMs.avg, 50)
  assert.equal(t210.animationFrames.intervalStatsMs.avg, 33)
  assert.equal(t111.animationFrames.fps.fromMeanInterval, 20)
  assert.equal(t210.animationFrames.overThresholds.over33_34ms.count, 0) // 33 ms is not > 33.34 ms
  assert.equal(t111.animationFrames.overThresholds.over33_34ms.count, 2)

  // long tasks stay inside their own thread
  assert.equal(t110.longTasks.count, 1)
  assert.equal(t110.longTasks.maxDurUs, 60_000)
  assert.equal(t111.longTasks.count, 1)
  assert.equal(t111.longTasks.maxDurUs, 70_000)
  assert.equal(t210.longTasks.count, 1)
  assert.equal(t210.longTasks.maxDurUs, 80_000)

  // the ignored thread contributes nothing anywhere
  assert.equal(summary.threads.some((thread) => thread.key === '1:12'), false)
  const allLongTaskDurations = summary.threads.flatMap((thread) => thread.longTasks.tasks.map((task) => task.durUs))
  assert.deepEqual(allLongTaskDurations.sort((a, b) => a - b), [60_000, 70_000, 80_000])

  // trace-wide sampling window still covers every event, analysed or not
  assert.equal(summary.sampling.windowStartUs, 100_000)
  assert.equal(summary.sampling.windowEndUs, 5_000_500) // last compositor frame start + 500 us dur
  assert.equal(summary.sampling.durationUs, 4_900_500)
})

test('outputs every matching CrRendererMain thread instead of only the first', () => {
  const summary = summarizeTrace([
    threadNameEvent(7, 1),
    threadNameEvent(7, 2),
    threadNameEvent(7, 3),
    runTask(7, 1, 1_000, 51_000),
    runTask(7, 2, 2_000, 52_000),
    runTask(7, 3, 3_000, 53_000),
  ])

  assert.deepEqual(summary.selection.matchedThreadKeys, ['7:1', '7:2', '7:3'])
  assert.deepEqual(
    summary.threads.map((thread) => thread.longTasks.maxDurUs),
    [51_000, 52_000, 53_000],
  )
})

/* ----------------------------------------------------- long task threshold */

test('long task threshold is exactly dur > 50000 us (strict)', () => {
  assert.equal(LONG_TASK_THRESHOLD_US, 50_000)

  const summary = summarizeTrace([
    threadNameEvent(1, 10),
    runTask(1, 10, 1_000_000, 49_999), // under
    runTask(1, 10, 2_000_000, 50_000), // exactly at threshold -> NOT a long task
    runTask(1, 10, 3_000_000, 50_001), // just over -> long task
    runTask(1, 10, 4_000_000, 250_000), // long task
  ])

  const thread = threadByKey(summary, '1:10')
  assert.equal(thread.longTasks.observedCompleteEvents, 4)
  assert.equal(thread.longTasks.count, 2)
  assert.deepEqual(
    thread.longTasks.tasks.map((task) => task.durUs),
    [50_001, 250_000],
  )
  assert.equal(thread.longTasks.totalDurUs, 300_001)
  assert.equal(thread.longTasks.maxDurMs, 250)
  assert.match(thread.longTasks.rule, /strictly greater/)
})

test('frame interval thresholds are strict at 20 ms and 33.34 ms', () => {
  const summary = summarizeTrace([
    threadNameEvent(1, 10),
    frame(1, 10, 3_000_000),
    frame(1, 10, 3_020_000), // 20 000 us = 20 ms  -> not > 20 ms
    frame(1, 10, 3_053_340), // 33 340 us = 33.34 ms -> not > 33.34 ms
    frame(1, 10, 3_086_681), // 33 341 us = 33.341 ms -> over both thresholds
  ])

  const frames = threadByKey(summary, '1:10').animationFrames
  assert.deepEqual(frames.intervalsUs, [20_000, 33_340, 33_341])
  assert.equal(frames.overThresholds.over20ms.thresholdMs, 20)
  assert.equal(frames.overThresholds.over20ms.count, 2)
  assert.equal(frames.overThresholds.over33_34ms.thresholdMs, 33.34)
  assert.equal(frames.overThresholds.over33_34ms.count, 1)
  assert.equal(frames.overThresholds.over20ms.comparison, 'intervalMs > thresholdMs (strictly greater)')
  assert.equal(frames.intervalStatsMs.p50, 33.34)
  assert.equal(frames.intervalStatsMs.avg, 28.894)
  assert.equal(frames.intervalStatsMs.min, 20)
  assert.equal(frames.intervalStatsMs.max, 33.341)
  closeTo(frames.fps.fromMeanInterval, 34.609, 0.002, 'fps from mean interval')
  closeTo(frames.fps.fromSamplingSpan, 34.61, 0.002, 'fps from sampling span')
})

/* ------------------------------------------------- frame interval / pacing */

test('frame interval distribution reports avg/p50/p95/p99/max, fps and over-threshold counts', () => {
  const summary = summarizeTrace([
    threadNameEvent(RENDERER_PID, RENDERER_TID),
    frame(RENDERER_PID, RENDERER_TID, 10_000_000),
    frame(RENDERER_PID, RENDERER_TID, 10_016_000), // 16 000 us
    frame(RENDERER_PID, RENDERER_TID, 10_036_001), // 20 001 us  (> 20 ms)
    frame(RENDERER_PID, RENDERER_TID, 10_069_341), // 33 340 us  (== 33.34 ms, not over)
    frame(RENDERER_PID, RENDERER_TID, 10_102_682), // 33 341 us  (> 33.34 ms)
    frame(RENDERER_PID, RENDERER_TID, 10_142_682), // 40 000 us  (> both)
  ])

  const frames = threadByKey(summary, `${RENDERER_PID}:${RENDERER_TID}`).animationFrames
  assert.equal(frames.dataAvailable, true)
  assert.equal(frames.unavailableReason, null)
  assert.equal(frames.frameEventCount, 6)
  assert.equal(frames.intervalCount, 5)
  assert.deepEqual(frames.intervalsUs, [16_000, 20_001, 33_340, 33_341, 40_000])

  assert.equal(frames.intervalStatsMs.unit, 'milliseconds')
  assert.equal(frames.intervalStatsMs.count, 5)
  assert.equal(frames.intervalStatsMs.min, 16)
  assert.equal(frames.intervalStatsMs.avg, 28.536)
  assert.equal(frames.intervalStatsMs.p50, 33.34)
  assert.equal(frames.intervalStatsMs.p95, 38.668)
  assert.equal(frames.intervalStatsMs.p99, 39.734)
  assert.equal(frames.intervalStatsMs.max, 40)

  // same numbers in the source unit
  assert.equal(frames.intervalStatsUs.avg, 28_536.4)
  assert.equal(frames.intervalStatsUs.p50, 33_340)
  assert.equal(frames.intervalStatsUs.p95, 38_668.2)
  assert.equal(frames.intervalStatsUs.p99, 39_733.64)
  assert.equal(frames.intervalStatsUs.max, 40_000)

  assert.equal(frames.overThresholds.over20ms.count, 4)
  assert.equal(frames.overThresholds.over33_34ms.count, 2)

  assert.equal(frames.fps.frameCount, 6)
  assert.equal(frames.fps.intervalCount, 5)
  assert.equal(frames.fps.meanIntervalMs, 28.536)
  assert.equal(frames.fps.fromMeanInterval, 35.043)
  assert.equal(frames.fps.fromSamplingSpan, 35.043)
  assert.equal(frames.frameSamplingSpanUs, 142_682)
  assert.equal(frames.frameSamplingSpanMs, 142.682)

  const thread = threadByKey(summary, `${RENDERER_PID}:${RENDERER_TID}`)
  assert.equal(thread.sampling.durationUs, 143_182) // last frame end 10 143 182 - first event 10 000 000
  assert.equal(summary.dataAvailability.animationFrameDataAvailable, true)
})

test('percentile helper uses R-7 linear interpolation', () => {
  const ascending = [1, 2, 3, 4]
  assert.equal(percentile(ascending, 0), 1)
  assert.equal(percentile(ascending, 50), 2.5)
  assert.equal(percentile(ascending, 100), 4)
  assert.equal(percentile([5], 95), 5)
  assert.equal(percentile([], 95), null)
  // unsorted input is the caller's mistake, but an ascending sample is what we always pass
  assert.equal(percentile([1, 2, 3], 95), 2.9)
})

/* ---------------------------------------------------------- empty / limits */

test('empty trace yields an explicit, non-crashing empty report', () => {
  for (const fixture of [{ traceEvents: [] }, []]) {
    const summary = summarizeTrace(fixture)
    assert.equal(summary.schema, SCHEMA)
    assert.equal(summary.input.eventCount, 0)
    assert.equal(summary.sampling.durationUs, 0)
    assert.equal(summary.sampling.windowStartUs, null)
    assert.equal(summary.sampling.windowEndUs, null)
    assert.equal(summary.selection.matchedThreadCount, 0)
    assert.deepEqual(summary.threads, [])
    assert.equal(summary.dataAvailability.crRendererMainThreadFound, false)
    assert.equal(summary.dataAvailability.animationFrameDataAvailable, false)
    assert.equal(summary.dataAvailability.fpsAssumedOrBackfilled, false)
    assert.ok(summary.warnings.length > 0, 'empty trace must warn')
    assert.match(summary.warnings.join(' | '), /no events|no CrRendererMain/)
  }
})

test('a trace with events but no thread_name metadata finds no thread', () => {
  const summary = summarizeTrace({ traceEvents: [runTask(1, 2, 1_000, 90_000), frame(1, 2, 2_000)] })
  assert.equal(summary.input.threadNameMetadataCount, 0)
  assert.equal(summary.selection.matchedThreadCount, 0)
  assert.deepEqual(summary.threads, [])
  assert.match(summary.warnings.join(' | '), /no "thread_name" metadata/)
  assert.equal(summary.sampling.durationUs, 90_000) // 1 000 us .. (1 000 + 90 000) us: the window is still reported
})

/* ------------------------------------------------------- incomplete events */

test('incomplete and unpaired events are ignored and counted, never guessed', () => {
  const summary = summarizeTrace([
    threadNameEvent(7, 7),
    runTask(7, 7, 5_000_000, undefined), // X without dur
    runTask(7, 7, 6_000_000, '50001'), // X with a string dur
    runTask(7, 7, undefined, 80_000), // X without ts
    runTask(7, 7, 9_000_000, null), // X with dur null
    { name: LONG_TASK_EVENT_NAME, cat: 'toplevel', ph: 'B', ts: 7_000_000, pid: 7, tid: 7 }, // begin, not complete
    runTask(7, 7, 8_000_000, 100_000), // the only complete long task
    // X event with a ts but no "dur" key at all -> still a usable start point
    { name: FRAME_EVENT_NAME, cat: 'devtools.timeline', ph: 'X', ts: 1_000_000, pid: 7, tid: 7 },
    frame(7, 7, 1_100_000, 0), // explicit dur 0
    frame(7, 7, undefined, 500), // no ts -> unusable
    { name: FRAME_EVENT_NAME, ph: 'X', ts: Number.NaN, dur: 500, pid: 7, tid: 7 }, // NaN ts -> unusable
    null,
    'not an event',
  ])

  const thread = threadByKey(summary, '7:7')
  assert.equal(thread.diagnostics.incompleteRunTaskEvents, 4)
  assert.equal(thread.diagnostics.runTaskEventsSkippedByPhase, 1)
  assert.equal(thread.diagnostics.incompleteFireAnimationFrameEvents, 2)
  assert.equal(summary.input.malformedEventCount, 2)

  assert.equal(thread.longTasks.observedCompleteEvents, 1)
  assert.equal(thread.longTasks.count, 1)
  assert.equal(thread.longTasks.maxDurUs, 100_000)
  assert.equal(thread.longTasks.thresholdUs, 50_000)

  // the two usable frame starts are the ones with a real ts; the B event is not a frame
  assert.equal(thread.animationFrames.frameEventCount, 2)
  assert.equal(thread.animationFrames.frameEventsWithDuration, 1)
  assert.deepEqual(thread.animationFrames.intervalsUs, [100_000])
  assert.equal(thread.animationFrames.fps.fromMeanInterval, 10)

  assert.match(summary.warnings.join(' | '), /incomplete RunTask/)
  assert.match(summary.warnings.join(' | '), /incomplete FireAnimationFrame/)
})

/* --------------------------------------------------- missing RAF behaviour */

test('without RAF events the frame data is unavailable and no fps is invented', () => {
  const summary = summarizeTrace({
    traceEvents: [
      processNameEvent(9),
      threadNameEvent(9, 9),
      runTask(9, 9, 1_000_000, 60_000),
      runTask(9, 9, 2_000_000, 90_000),
    ],
  })

  const thread = threadByKey(summary, '9:9')
  const frames = thread.animationFrames
  assert.equal(frames.dataAvailable, false)
  assert.equal(frames.frameEventCount, 0)
  assert.match(frames.unavailableReason, /UNAVAILABLE/)
  assert.match(frames.unavailableReason, /no frame rate is assumed/)
  assert.equal(frames.intervalStatsMs, null)
  assert.equal(frames.intervalStatsUs, null)
  assert.equal(frames.fps, null)
  assert.equal(frames.overThresholds.over20ms.count, null)
  assert.equal(frames.overThresholds.over33_34ms.count, null)
  assert.equal(frames.overThresholds.over20ms.thresholdMs, 20)
  assert.equal(frames.overThresholds.over33_34ms.thresholdMs, 33.34)

  assert.equal(summary.dataAvailability.animationFrameDataAvailable, false)
  assert.match(summary.dataAvailability.animationFrameDataUnavailableReason, /FireAnimationFrame/)
  assert.equal(summary.dataAvailability.fpsAssumedOrBackfilled, false)

  // long tasks are still reported
  assert.equal(thread.longTasks.count, 2)

  // nothing anywhere back-fills 60 fps
  assert.equal(/"fps":\s*60\b/.test(JSON.stringify(summary)), false)
  assert.equal(/"fromMeanInterval":\s*60\b/.test(JSON.stringify(summary)), false)
})

test('a single FireAnimationFrame start is not enough for an interval distribution', () => {
  const summary = summarizeTrace([threadNameEvent(9, 9), frame(9, 9, 1_000_000)])
  const frames = threadByKey(summary, '9:9').animationFrames
  assert.equal(frames.frameEventCount, 1)
  assert.equal(frames.dataAvailable, false)
  assert.match(frames.unavailableReason, /at least 2/)
  assert.equal(frames.fps, null)
  assert.equal(frames.intervalStatsMs, null)
})

test('other frame-like event names are never used as a substitute for FireAnimationFrame', () => {
  const summary = summarizeTrace([
    threadNameEvent(9, 9),
    { name: 'RequestAnimationFrame', cat: 'devtools.timeline', ph: 'X', ts: 1_000_000, dur: 10, pid: 9, tid: 9 },
    { name: 'BeginFrame', cat: 'devtools.timeline', ph: 'I', ts: 1_016_000, pid: 9, tid: 9 },
  ])
  const frames = threadByKey(summary, '9:9').animationFrames
  assert.equal(frames.frameEventCount, 0)
  assert.equal(frames.dataAvailable, false)
  assert.equal(frames.fps, null)
  assert.equal(threadByKey(summary, '9:9').diagnostics.otherFrameLikeEvents, 2)
  assert.match(summary.warnings.join(' | '), /NOT used as a frame-pacing source/)
})

/* --------------------------------------------------------------------- CLI */

test('CLI writes a machine JSON report and leaves the input trace untouched', () => {
  withTempDir('astaria-trace-cli-', (dir) => {
    const inputPath = join(dir, 'trace.json')
    const outputPath = join(dir, 'summary.json')
    const fixture = {
      traceEvents: [
        threadNameEvent(1, 10),
        runTask(1, 10, 1_000_000, 60_001),
        frame(1, 10, 2_000_000),
        frame(1, 10, 2_016_000),
      ],
    }
    writeFileSync(inputPath, JSON.stringify(fixture))
    const beforeBytes = readFileSync(inputPath)
    const beforeStat = statSync(inputPath)

    const result = spawnSync(process.execPath, [SCRIPT_PATH, inputPath, outputPath], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stderr.trim(), `report written to ${resolve(outputPath)}`)
    const fromStdout = JSON.parse(result.stdout)
    const fromFile = JSON.parse(readFileSync(outputPath, 'utf8'))

    assert.deepEqual(fromFile, fromStdout)
    assert.equal(fromStdout.schema, SCHEMA)
    assert.equal(fromStdout.invocation.command, USAGE)
    assert.equal(fromStdout.invocation.inputPath, inputPath)
    assert.equal(fromStdout.invocation.outputPath, outputPath)
    assert.match(fromStdout.invocation.commandLine, /summarize-trace\.mjs/)
    assert.match(fromStdout.invocation.commandLine, /trace\.json/)
    assert.equal(fromStdout.input.bytes, beforeBytes.byteLength)
    assert.equal(fromStdout.input.access, 'read-only: the input trace is parsed in memory and never written to')
    assert.equal(threadByKey(fromStdout, '1:10').longTasks.count, 1)

    // the original trace is byte-identical and untouched
    assert.deepEqual(readFileSync(inputPath), beforeBytes)
    assert.equal(statSync(inputPath).mtimeMs, beforeStat.mtimeMs)
  })
})

test('CLI prints JSON to stdout when no output path is given', () => {
  withTempDir('astaria-trace-cli-', (dir) => {
    const inputPath = join(dir, 'trace.json')
    writeFileSync(inputPath, JSON.stringify([threadNameEvent(1, 10), frame(1, 10, 0), frame(1, 10, 16_000)]))
    const result = spawnSync(process.execPath, [SCRIPT_PATH, inputPath], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.input.format, 'bare-array')
    assert.equal(summary.invocation.outputPath, null)
    assert.equal(threadByKey(summary, '1:10').animationFrames.fps.fromMeanInterval, 62.5)
  })
})

test('CLI refuses to write the report over the input trace', () => {
  withTempDir('astaria-trace-cli-', (dir) => {
    const inputPath = join(dir, 'trace.json')
    writeFileSync(inputPath, JSON.stringify({ traceEvents: [threadNameEvent(1, 10)] }))
    const before = readFileSync(inputPath)

    const result = spawnSync(process.execPath, [SCRIPT_PATH, inputPath, inputPath], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(JSON.parse(result.stderr).error.code, 'output-would-overwrite-input')
    assert.deepEqual(readFileSync(inputPath), before)
  })
})

test('CLI reports usage, read and format errors with JSON on stderr', () => {
  withTempDir('astaria-trace-cli-', (dir) => {
    const noArgs = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8' })
    assert.equal(noArgs.status, 2)
    assert.equal(JSON.parse(noArgs.stderr).error.code, 'bad-usage')

    const badFlag = spawnSync(process.execPath, [SCRIPT_PATH, '--nope', 'x.json'], { encoding: 'utf8' })
    assert.equal(badFlag.status, 2)
    assert.equal(JSON.parse(badFlag.stderr).error.code, 'unknown-flag')

    const missing = spawnSync(process.execPath, [SCRIPT_PATH, join(dir, 'nope.json')], { encoding: 'utf8' })
    assert.equal(missing.status, 1)
    assert.equal(JSON.parse(missing.stderr).error.code, 'input-unreadable')

    const brokenPath = join(dir, 'broken.json')
    writeFileSync(brokenPath, '{"traceEvents": [')
    const broken = spawnSync(process.execPath, [SCRIPT_PATH, brokenPath], { encoding: 'utf8' })
    assert.equal(broken.status, 1)
    assert.equal(JSON.parse(broken.stderr).error.code, 'invalid-trace-format')

    const help = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /Usage:/)
    assert.match(help.stdout, /no implicit 60 fps/)
  })
})

/* ------------------------------------------------------------- invocation */

test('the report echoes the command it was run with', () => {
  const argv = ['/usr/local/bin/node', 'scripts/summarize-trace.mjs', 'trace.json', 'out.json']
  assert.equal(commandLineFromArgv(argv), 'node scripts/summarize-trace.mjs trace.json out.json')

  const summary = summarizeTrace({ traceEvents: [] }, { argv: argv.slice(1), inputPath: 'trace.json', outputPath: 'out.json' })
  assert.equal(summary.invocation.command, USAGE)
  assert.equal(summary.invocation.commandLine, 'node scripts/summarize-trace.mjs trace.json out.json')
  assert.deepEqual(summary.invocation.argv, ['scripts/summarize-trace.mjs', 'trace.json', 'out.json'])
})

/* --------------------------------------------- Chrome export regressions */

test('modern Chromium task aliases are recognized without double-counting nested wrappers', () => {
  const summary = summarizeTrace([
    threadNameEvent(1, 10),
    { name: 'ThreadControllerImpl::RunTask', ph: 'X', pid: 1, tid: 10, ts: 1_000_000, dur: 80_000 },
    runTask(1, 10, 1_001_000, 75_000), // a nested scheduler wrapper, not another blocking period
    { name: 'ThreadControllerWithMessagePumpImpl::RunTask', ph: 'X', pid: 1, tid: 10, ts: 2_000_000, dur: 50_000 },
    { name: 'TaskQueueManager::ProcessTaskFromWorkQueue', ph: 'X', pid: 1, tid: 10, ts: 3_000_000, dur: 60_000 },
  ])
  const thread = threadByKey(summary, '1:10')
  assert.equal(thread.longTasks.observedCompleteEvents, 4)
  assert.equal(thread.longTasks.analyzedTopLevelEvents, 3)
  assert.equal(thread.longTasks.count, 2)
  assert.equal(thread.longTasks.totalDurMs, 140)
  assert.equal(thread.diagnostics.nestedTaskEventsIgnored, 1)
  assert.deepEqual(thread.longTasks.tasks.map((task) => task.eventName), [
    'ThreadControllerImpl::RunTask', 'TaskQueueManager::ProcessTaskFromWorkQueue',
  ])
})

test('nested B/E slices reconstruct task duration while anonymous E closes the innermost slice', () => {
  const event = (name, ph, ts) => ({ name, ph, ts, pid: 1, tid: 10 })
  const summary = summarizeTrace([
    threadNameEvent(1, 10),
    event('ThreadControllerImpl::RunTask', 'B', 1_000_000),
    event('FunctionCall', 'B', 1_010_000),
    event(undefined, 'E', 1_020_000),
    event(undefined, 'E', 1_075_000),
    event('RunTask', 'B', 2_000_000),
    event('RunTask', 'E', 2_050_000),
  ])
  const thread = threadByKey(summary, '1:10')
  assert.equal(thread.longTasks.count, 1)
  assert.equal(thread.longTasks.maxDurUs, 75_000)
  assert.equal(thread.longTasks.tasks[0].sourcePhase, 'B/E')
  assert.equal(thread.longTasks.observedCompleteEvents, 2)
  assert.equal(thread.diagnostics.reconstructedTaskEvents, 2)
  assert.equal(thread.diagnostics.runTaskEventsSkippedByPhase, 0)
})

test('B/E slices cannot pair across threads or process boundaries', () => {
  const summary = summarizeTrace([
    threadNameEvent(1, 10), threadNameEvent(1, 11), threadNameEvent(2, 10),
    { name: 'RunTask', ph: 'B', ts: 1_000_000, pid: 1, tid: 10 },
    { ph: 'E', ts: 1_100_000, pid: 1, tid: 11 },
    { ph: 'E', ts: 1_200_000, pid: 2, tid: 10 },
  ])
  for (const thread of summary.threads) {
    assert.equal(thread.longTasks.dataAvailable, false)
    assert.equal(thread.longTasks.count, null)
    assert.equal(thread.diagnostics.reconstructedTaskEvents, 0)
  }
  assert.equal(summary.dataAvailability.longTaskDataAvailable, false)
})

test('a renderer without recorded task events reports unavailable instead of zero long tasks', () => {
  const summary = summarizeTrace([threadNameEvent(1, 10), frame(1, 10, 0), frame(1, 10, 16_667)])
  const thread = threadByKey(summary, '1:10')
  assert.equal(thread.longTasks.dataAvailable, false)
  assert.equal(thread.longTasks.count, null)
  assert.equal(thread.longTasks.totalDurMs, null)
  assert.match(thread.longTasks.unavailableReason, /zero long tasks cannot be inferred/)
})

test('FireAnimationFrame B/E pairs contribute one start each and exclude E timestamps', () => {
  const event = (ph, ts) => ({ name: FRAME_EVENT_NAME, ph, ts, pid: 1, tid: 10 })
  const summary = summarizeTrace([
    threadNameEvent(1, 10),
    event('B', 1_000_000), event('E', 1_001_000),
    event('B', 1_016_000), event('E', 1_018_000),
  ])
  const thread = threadByKey(summary, '1:10')
  assert.equal(thread.animationFrames.frameEventCount, 2)
  assert.deepEqual(thread.animationFrames.intervalsUs, [16_000])
  assert.equal(thread.animationFrames.fps.fromMeanInterval, 62.5)
  assert.equal(thread.diagnostics.fireAnimationFrameEventsSkippedByPhase, 2)
})

test('multiple RAF callbacks remain callback observations and are not relabeled as presented frames', () => {
  const summary = summarizeTrace([
    threadNameEvent(1, 10),
    frame(1, 10, 1_000_000), frame(1, 10, 1_000_100),
    frame(1, 10, 1_016_667), frame(1, 10, 1_016_767),
  ])
  const thread = threadByKey(summary, '1:10')
  assert.equal(thread.animationFrames.frameEventCount, 4)
  assert.match(thread.animationFrames.fps.unit, /not presented-frame fps/)
  assert.match(thread.animationFrames.limitation, /Several callbacks/)
  assert.match(thread.warnings.join(' '), /multiple callbacks in one display frame/)
})

test('metadata zero timestamps do not inflate the recording window and displayTimeUnit does not rescale events', () => {
  const summary = summarizeTrace({
    displayTimeUnit: 'ns',
    traceEvents: [
      { ...threadNameEvent(1, 10), ts: 0 },
      { ...processNameEvent(1), ts: 0 },
      runTask(1, 10, 9_000_000, 60_000),
      frame(1, 10, 9_100_000), frame(1, 10, 9_116_000),
    ],
  })
  assert.equal(summary.sampling.windowStartUs, 9_000_000)
  assert.equal(summary.sampling.durationUs, 116_500)
  assert.equal(threadByKey(summary, '1:10').sampling.durationUs, 116_500)
  assert.equal(threadByKey(summary, '1:10').longTasks.maxDurMs, 60)
})

test('CLI refuses symlink and hard-link output aliases without changing the original trace', () => {
  withTempDir('astaria-trace-alias-', (dir) => {
    const inputPath = join(dir, 'trace.json')
    writeFileSync(inputPath, JSON.stringify({ traceEvents: [threadNameEvent(1, 10)] }))
    const before = readFileSync(inputPath)
    const beforeMtime = statSync(inputPath).mtimeMs
    for (const [name, createLink] of [['symlink.json', symlinkSync], ['hardlink.json', linkSync]]) {
      const outputPath = join(dir, name)
      createLink(inputPath, outputPath)
      const result = spawnSync(process.execPath, [SCRIPT_PATH, inputPath, outputPath], { encoding: 'utf8' })
      assert.equal(result.status, 2)
      assert.equal(JSON.parse(result.stderr).error.code, 'output-would-overwrite-input')
      assert.deepEqual(readFileSync(inputPath), before)
      assert.equal(statSync(inputPath).mtimeMs, beforeMtime)
    }
  })
})

test('CLI reads compressed DevTools exports by gzip signature and preserves their exact bytes', () => {
  withTempDir('astaria-trace-gzip-', (dir) => {
    const inputPath = join(dir, 'trace.json.gz')
    const source = gzipSync(JSON.stringify({ traceEvents: [threadNameEvent(1, 10), runTask(1, 10, 1000, 60_000)] }))
    writeFileSync(inputPath, source)
    const result = spawnSync(process.execPath, [SCRIPT_PATH, inputPath], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.input.compression, 'gzip')
    assert.equal(summary.input.bytes, source.byteLength)
    assert.equal(threadByKey(summary, '1:10').longTasks.maxDurMs, 60)
    assert.deepEqual(readFileSync(inputPath), source)
  })
})
