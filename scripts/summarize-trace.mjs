#!/usr/bin/env node
/**
 * ASTARIA-P0-TRACE-0915 — Chrome DevTools trace JSON summarizer.
 *
 * CLI:
 *   node scripts/summarize-trace.mjs <trace.json> [out.json]
 *
 * Contract implemented here (machine-readable JSON on stdout, same JSON written to [out.json]):
 *   - accepts {"traceEvents":[...]} and a bare [...] array;
 *   - finds every thread whose `thread_name` metadata event is "CrRendererMain"
 *     (pid + tid identify a thread) and analyses EACH matching thread separately —
 *     events of different threads are never merged into one series;
 *   - long tasks: RunTask / Chromium scheduler aliases, complete X events or
 *     correctly nested synchronous B/E pairs, with dur > 50000 us (strict);
 *   - frame pacing: per-thread distribution of intervals between consecutive
 *     `FireAnimationFrame` start timestamps (avg / p50 / p95 / p99 / max), derived fps
 *     and the counts of intervals over 20 ms and over 33.34 ms;
 *   - reports the sampling window/duration together with the time unit;
 *   - when a thread has no (or a single) FireAnimationFrame start timestamp the frame
 *     data is reported as UNAVAILABLE — no frame rate is ever assumed or back-filled
 *     (there is no implicit "60 fps");
 *   - the input trace is opened read-only and is never modified.
 *
 * Node built-in modules only: no dependencies, no network access.
 */

import { readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import process from 'node:process'

export const TASK_ID = 'ASTARIA-P0-TRACE-0915'
export const SCHEMA = 'astaria.trace-summary/v1'
export const ERROR_SCHEMA = 'astaria.trace-summary-error/v1'
export const USAGE = 'node scripts/summarize-trace.mjs <trace.json> [out.json]'

export const CR_RENDERER_MAIN_THREAD_NAME = 'CrRendererMain'
export const LONG_TASK_EVENT_NAME = 'RunTask'
export const LONG_TASK_EVENT_NAMES = Object.freeze([
  LONG_TASK_EVENT_NAME,
  'ThreadControllerImpl::RunTask',
  'ThreadControllerWithMessagePumpImpl::RunTask',
  'TaskQueueManager::ProcessTaskFromWorkQueue',
])
export const LONG_TASK_THRESHOLD_US = 50000
export const FRAME_EVENT_NAME = 'FireAnimationFrame'
export const FRAME_INTERVAL_THRESHOLDS_MS = Object.freeze([20, 33.34])

const PERCENTILE_METHOD = 'R-7 (numpy default): linear interpolation between closest ranks of the ascending sample'
const MS_PER_US = 1 / 1000
const US_PER_MS = 1000
const LONG_TASK_EVENT_SET = new Set(LONG_TASK_EVENT_NAMES)

/** Error type for trace input problems (bad JSON, wrong shape). */
export class TraceFormatError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'TraceFormatError'
    this.code = 'invalid-trace-format'
    if (cause !== undefined) this.cause = cause
  }
}

/* ------------------------------------------------------------------ helpers */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Round to a fixed number of decimals (used only for reporting, never for comparisons). */
export function roundTo(value, digits) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** Microseconds -> milliseconds, 3 decimals (1 us resolution). */
export function usToMs(us) {
  return roundTo(us * MS_PER_US, 3)
}

/** Microseconds -> seconds, 6 decimals. */
export function usToSeconds(us) {
  return roundTo(us / 1e6, 6)
}

/**
 * Percentile of an ascending numeric sample.
 * Method: R-7 / numpy default — linear interpolation between closest ranks.
 * Returns null for an empty sample.
 */
export function percentile(sortedAscending, p) {
  const n = sortedAscending.length
  if (n === 0) return null
  if (n === 1) return sortedAscending[0]
  const rank = (p / 100) * (n - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  if (lower === upper) return sortedAscending[lower]
  const fraction = rank - lower
  return sortedAscending[lower] + fraction * (sortedAscending[upper] - sortedAscending[lower])
}

function threadSortKey(thread) {
  const pid = isFiniteNumber(thread.pid) ? thread.pid : Number.POSITIVE_INFINITY
  const tid = isFiniteNumber(thread.tid) ? thread.tid : Number.POSITIVE_INFINITY
  return [pid, tid, thread.key]
}

function compareThreads(a, b) {
  const [apid, atid, akey] = threadSortKey(a)
  const [bpid, btid, bkey] = threadSortKey(b)
  if (apid !== bpid) return apid - bpid
  if (atid !== btid) return atid - btid
  return akey < bkey ? -1 : akey > bkey ? 1 : 0
}

function quoteArg(arg) {
  const text = String(arg)
  return /[\s"']/u.test(text) ? JSON.stringify(text) : text
}

/**
 * Rebuild the command line as it was actually invoked.
 * Expected shape is [nodeBinary, scriptPath, ...args] (process.argv) or [scriptPath, ...args]
 * (process.argv.slice(1)); both produce a "node <script> <args>" command line.
 */
export function commandLineFromArgv(argv) {
  const list = Array.isArray(argv) ? [...argv] : []
  if (list.length === 0) return USAGE
  const isNodeBinary = /(?:^|[/\\])node(?:\.exe)?$/iu.test(list[0])
  const head = isNodeBinary ? ['node', ...list.slice(1)] : ['node', ...list]
  return head.map(quoteArg).join(' ')
}

function statsBlock(sampleUs) {
  const ascending = [...sampleUs].sort((a, b) => a - b)
  const count = ascending.length
  const total = ascending.reduce((sum, value) => sum + value, 0)
  const mean = count === 0 ? null : total / count
  const samples = {
    count,
    totalUs: count === 0 ? 0 : total,
    minUs: count === 0 ? null : ascending[0],
    maxUs: count === 0 ? null : ascending[count - 1],
    avgUs: mean === null ? null : roundTo(mean, 3),
    p50Us: percentile(ascending, 50) === null ? null : roundTo(percentile(ascending, 50), 3),
    p95Us: percentile(ascending, 95) === null ? null : roundTo(percentile(ascending, 95), 3),
    p99Us: percentile(ascending, 99) === null ? null : roundTo(percentile(ascending, 99), 3),
  }
  return { meanUs: mean, samples }
}

function toMillisecondsBlock(samples) {
  const convert = (value) => (value === null || value === undefined ? null : usToMs(value))
  return {
    unit: 'milliseconds',
    unitSymbol: 'ms',
    sourceUnit: 'microseconds',
    sourceUnitSymbol: 'us',
    conversion: 'ms = us / 1000',
    count: samples.count,
    min: convert(samples.minUs),
    avg: convert(samples.avgUs),
    p50: convert(samples.p50Us),
    p95: convert(samples.p95Us),
    p99: convert(samples.p99Us),
    max: convert(samples.maxUs),
  }
}

/* ------------------------------------------------------------- trace intake */

/**
 * Accepts either {"traceEvents":[...]} (Chrome / DevTools export) or a bare array.
 * Returns { events, format }.
 */
export function extractTraceEvents(parsed) {
  if (Array.isArray(parsed)) return { events: parsed, format: 'bare-array' }
  if (isPlainObject(parsed)) {
    if (parsed.traceEvents === undefined) {
      throw new TraceFormatError(
        'trace JSON object has no "traceEvents" key; expected {"traceEvents":[...]} or a bare [...] event array',
      )
    }
    if (!Array.isArray(parsed.traceEvents)) {
      throw new TraceFormatError('"traceEvents" is present but is not an array')
    }
    return { events: parsed.traceEvents, format: 'traceEvents' }
  }
  throw new TraceFormatError('unsupported trace JSON root: expected an object with "traceEvents" or a bare array')
}

/** Parse trace text (tolerates a leading BOM). */
export function parseTraceText(text) {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(cleaned)
  } catch (error) {
    throw new TraceFormatError(`trace is not valid JSON: ${error.message}`, error)
  }
}

/* ------------------------------------------------------------ thread slices */

/** Pair synchronous slices using a separate nested stack for this thread only. */
function pairedTaskEvents(events) {
  const stack = []
  const completed = []
  const pairedBegins = new Set()
  let unmatchedEnds = 0
  // Chrome JSON is not required to be globally timestamp-sorted. Stable sort
  // preserves the producer's order for nested events with equal timestamps.
  const ordered = events.filter((event) => isFiniteNumber(event.ts)).sort((a, b) => a.ts - b.ts)
  for (const event of ordered) {
    if (event.ph === 'B') {
      stack.push(event)
    } else if (event.ph === 'E') {
      const begin = stack[stack.length - 1]
      if (!begin || (event.name && event.name !== begin.name)) {
        unmatchedEnds += 1
        continue
      }
      stack.pop()
      pairedBegins.add(begin)
      if (LONG_TASK_EVENT_SET.has(begin.name)) {
        completed.push({ ...begin, ph: 'X', dur: event.ts - begin.ts, sourcePhase: 'B/E' })
      }
    }
  }
  return { completed, pairedBegins, unmatchedEnds }
}

function analyzeThread(bucket, context) {
  const { threadName, processName } = context
  const warnings = []

  const longTaskCandidates = []
  const frameStarts = []
  let windowStartUs = Number.POSITIVE_INFINITY
  let windowEndUs = Number.NEGATIVE_INFINITY
  let timestampedEvents = 0

  let runTaskIncomplete = 0
  let runTaskSkippedByPhase = 0
  let frameIncomplete = 0
  let frameEventsWithDuration = 0
  let frameEventsSkippedByPhase = 0
  let otherFrameLikeEvents = 0
  const paired = pairedTaskEvents(bucket.events)

  for (const event of [...bucket.events, ...paired.completed]) {
    const name = typeof event.name === 'string' ? event.name : ''
    const phase = typeof event.ph === 'string' ? event.ph : null
    const tsUs = isFiniteNumber(event.ts) ? event.ts : null
    const durUs = isFiniteNumber(event.dur) ? event.dur : null

    if (tsUs !== null && phase !== 'M' && event.sourcePhase !== 'B/E') {
      timestampedEvents += 1
      const endUs = durUs !== null && durUs > 0 ? tsUs + durUs : tsUs
      if (tsUs < windowStartUs) windowStartUs = tsUs
      if (endUs > windowEndUs) windowEndUs = endUs
    }

    if (LONG_TASK_EVENT_SET.has(name)) {
      if (phase !== 'X') {
        if (!(phase === 'B' && paired.pairedBegins.has(event)) && phase !== 'E') runTaskSkippedByPhase += 1
        continue
      }
      if (tsUs === null || durUs === null || durUs < 0) {
        runTaskIncomplete += 1
        continue
      }
      longTaskCandidates.push({ tsUs, durUs, name, sourcePhase: event.sourcePhase ?? 'X', cat: typeof event.cat === 'string' ? event.cat : null })
      continue
    }

    if (name === FRAME_EVENT_NAME) {
      // A B/E pair has exactly one callback start. An E event is never a frame.
      if (phase !== 'X' && phase !== 'B') {
        frameEventsSkippedByPhase += 1
        continue
      }
      if (tsUs === null) {
        frameIncomplete += 1
        continue
      }
      frameStarts.push(tsUs)
      if (durUs !== null && durUs >= 0) frameEventsWithDuration += 1
      continue
    }

    if (name === 'RequestAnimationFrame' || name === 'BeginFrame' || name === 'DrawFrame') {
      otherFrameLikeEvents += 1
    }
  }

  const hasWindow = timestampedEvents > 0
  const threadWindowUs = hasWindow ? windowEndUs - windowStartUs : 0

  /* ---- Do not count nested aliases as separate main-thread tasks. ---- */
  const topLevelTasks = []
  let outerTaskEnd = Number.NEGATIVE_INFINITY
  for (const task of longTaskCandidates.sort((a, b) => a.tsUs - b.tsUs || b.durUs - a.durUs)) {
    if (task.tsUs + task.durUs <= outerTaskEnd) continue
    topLevelTasks.push(task)
    outerTaskEnd = task.tsUs + task.durUs
  }
  const longTaskDataAvailable = topLevelTasks.length > 0
  const longTasks = topLevelTasks
    .filter((task) => task.durUs > LONG_TASK_THRESHOLD_US)
    .sort((a, b) => a.tsUs - b.tsUs || a.durUs - b.durUs)
  const longTaskTotalUs = longTasks.reduce((sum, task) => sum + task.durUs, 0)
  const longTaskMaxUs = longTasks.length === 0 ? null : longTasks.reduce((max, task) => Math.max(max, task.durUs), 0)

  /* ---- frame pacing: start-to-start intervals inside THIS thread only ---- */
  const ascendingFrameStarts = [...frameStarts].sort((a, b) => a - b)
  const intervalsUs = []
  for (let index = 1; index < ascendingFrameStarts.length; index += 1) {
    intervalsUs.push(ascendingFrameStarts[index] - ascendingFrameStarts[index - 1])
  }
  const frameCount = ascendingFrameStarts.length
  const frameSpanUs = frameCount >= 2 ? ascendingFrameStarts[frameCount - 1] - ascendingFrameStarts[0] : 0

  let unavailableReason = null
  if (frameCount === 0) {
    unavailableReason =
      `no ${FRAME_EVENT_NAME} events on this thread: frame interval distribution and fps are UNAVAILABLE ` +
      '(no frame rate is assumed or back-filled)'
  } else if (frameCount === 1) {
    unavailableReason =
      `only 1 ${FRAME_EVENT_NAME} start timestamp on this thread: at least 2 are required for an interval ` +
      'distribution, so frame interval statistics and fps are UNAVAILABLE (no frame rate is assumed or back-filled)'
  }
  const dataAvailable = intervalsUs.length > 0

  const frameStats = dataAvailable ? statsBlock(intervalsUs) : null
  const intervalStatsUs = frameStats
    ? {
        unit: 'microseconds',
        unitSymbol: 'us',
        percentileMethod: PERCENTILE_METHOD,
        count: frameStats.samples.count,
        min: frameStats.samples.minUs,
        avg: frameStats.samples.avgUs,
        p50: frameStats.samples.p50Us,
        p95: frameStats.samples.p95Us,
        p99: frameStats.samples.p99Us,
        max: frameStats.samples.maxUs,
      }
    : null
  const intervalStatsMs = frameStats ? { ...toMillisecondsBlock(frameStats.samples), percentileMethod: PERCENTILE_METHOD } : null

  let fps = null
  if (dataAvailable && frameStats.meanUs !== null && frameStats.meanUs > 0) {
    const meanIntervalMs = usToMs(frameStats.meanUs)
    const spanSeconds = frameSpanUs / 1e6
    fps = {
      unit: 'animation-frame callbacks per second (not presented-frame fps)',
      frameCount,
      intervalCount: intervalsUs.length,
      meanIntervalMs,
      fromMeanInterval: roundTo(1e6 / frameStats.meanUs, 3),
      fromSamplingSpan: spanSeconds > 0 ? roundTo((frameCount - 1) / spanSeconds, 3) : null,
      definitions: {
        fromMeanInterval: '1000 / mean(start-to-start interval in ms)',
        fromSamplingSpan: '(frameCount - 1) / (span between first and last frame start, in seconds)',
      },
    }
  }

  const overThresholds = {}
  for (const thresholdMs of FRAME_INTERVAL_THRESHOLDS_MS) {
    const label = `over${String(thresholdMs).replace('.', '_')}ms`
    overThresholds[label] = {
      thresholdMs,
      comparison: 'intervalMs > thresholdMs (strictly greater)',
      count: dataAvailable ? intervalsUs.filter((us) => us * MS_PER_US > thresholdMs).length : null,
    }
  }

  if (!dataAvailable) warnings.push(`thread ${bucket.key}: ${unavailableReason}`)
  if (otherFrameLikeEvents > 0 && frameCount < 2) {
    warnings.push(
      `thread ${bucket.key}: found ${otherFrameLikeEvents} event(s) named RequestAnimationFrame/BeginFrame/DrawFrame ` +
        `but ${frameCount} named ${FRAME_EVENT_NAME}; those are NOT used as a frame-pacing source`,
    )
  }
  if (runTaskIncomplete > 0) warnings.push(`thread ${bucket.key}: ${runTaskIncomplete} incomplete ${LONG_TASK_EVENT_NAME} event(s) ignored`)
  if (frameIncomplete > 0) warnings.push(`thread ${bucket.key}: ${frameIncomplete} incomplete ${FRAME_EVENT_NAME} event(s) ignored`)
  if (!longTaskDataAvailable) warnings.push(`thread ${bucket.key}: no complete RunTask or supported scheduler task events; long-task data is UNAVAILABLE, not a measured zero`)
  if (intervalsUs.some((interval) => interval < 1000)) warnings.push(`thread ${bucket.key}: RAF starts less than 1 ms apart may be multiple callbacks in one display frame; callback cadence is not presented-frame fps`)

  return {
    key: bucket.key,
    pid: bucket.pid,
    tid: bucket.tid,
    threadName,
    processName: processName ?? null,
    eventCount: bucket.events.length,
    timestampedEventCount: timestampedEvents,
    sampling: {
      basis: 'min(ts) .. max(ts + dur) over this thread\'s non-metadata timestamped events',
      unit: 'microseconds',
      unitSymbol: 'us',
      windowStartUs: hasWindow ? windowStartUs : null,
      windowEndUs: hasWindow ? windowEndUs : null,
      durationUs: threadWindowUs,
      durationMs: usToMs(threadWindowUs),
      durationSeconds: usToSeconds(threadWindowUs),
    },
    longTasks: {
      eventName: LONG_TASK_EVENT_NAME,
      eventNames: LONG_TASK_EVENT_NAMES,
      phase: 'X or paired synchronous B/E',
      dataAvailable: longTaskDataAvailable,
      unavailableReason: longTaskDataAvailable ? null : 'No complete supported scheduler task events were recorded; zero long tasks cannot be inferred.',
      thresholdUs: LONG_TASK_THRESHOLD_US,
      thresholdMs: usToMs(LONG_TASK_THRESHOLD_US),
      rule: 'supported scheduler task name, X duration or same-thread nested B/E duration, dur > 50000 us (strictly greater); nested task aliases count once',
      observedCompleteEvents: longTaskCandidates.length,
      analyzedTopLevelEvents: topLevelTasks.length,
      count: longTaskDataAvailable ? longTasks.length : null,
      totalDurUs: longTaskDataAvailable ? longTaskTotalUs : null,
      totalDurMs: longTaskDataAvailable ? usToMs(longTaskTotalUs) : null,
      maxDurUs: longTaskMaxUs,
      maxDurMs: longTaskMaxUs === null ? null : usToMs(longTaskMaxUs),
      tasks: longTasks.map((task) => ({
        eventName: task.name,
        sourcePhase: task.sourcePhase,
        tsUs: task.tsUs,
        tsMs: usToMs(task.tsUs),
        durUs: task.durUs,
        durMs: usToMs(task.durUs),
        overThresholdByUs: task.durUs - LONG_TASK_THRESHOLD_US,
        cat: task.cat,
      })),
    },
    animationFrames: {
      eventName: FRAME_EVENT_NAME,
      startBasis: 'X or B event ts (callback start), ascending, within this thread only; E events excluded',
      limitation: 'FireAnimationFrame records callbacks, not compositor presentation. Several callbacks may run in one display frame; this series alone does not prove displayed fps.',
      dataAvailable,
      unavailableReason,
      frameEventCount: frameCount,
      frameEventsWithDuration,
      firstFrameTsUs: frameCount === 0 ? null : ascendingFrameStarts[0],
      lastFrameTsUs: frameCount === 0 ? null : ascendingFrameStarts[frameCount - 1],
      frameSamplingSpanUs: frameSpanUs,
      frameSamplingSpanMs: usToMs(frameSpanUs),
      frameSamplingSpanSeconds: usToSeconds(frameSpanUs),
      intervalCount: intervalsUs.length,
      intervalsUs,
      intervalStatsUs,
      intervalStatsMs,
      fps,
      overThresholds,
    },
    diagnostics: {
      totalEvents: bucket.events.length,
      otherFrameLikeEvents,
      incompleteRunTaskEvents: runTaskIncomplete,
      runTaskEventsSkippedByPhase: runTaskSkippedByPhase,
      incompleteFireAnimationFrameEvents: frameIncomplete,
      fireAnimationFrameEventsSkippedByPhase: frameEventsSkippedByPhase,
      reconstructedTaskEvents: paired.completed.length,
      nestedTaskEventsIgnored: longTaskCandidates.length - topLevelTasks.length,
      unmatchedSynchronousEndEvents: paired.unmatchedEnds,
    },
    warnings,
  }
}

/* ------------------------------------------------------------- summarizer */

/**
 * Summarize a parsed Chrome DevTools trace.
 *
 * @param {unknown} parsed parsed trace JSON ({"traceEvents":[...]} or bare array)
 * @param {{inputPath?: string|null, absoluteInputPath?: string|null, outputPath?: string|null,
 *          bytes?: number|null, argv?: string[]|null}} [options]
 * @returns {object} machine-readable summary
 */
export function summarizeTrace(parsed, options = {}) {
  const { events, format } = extractTraceEvents(parsed)
  const warnings = []

  let malformedEvents = 0
  let unnamedEvents = 0
  let windowStartUs = Number.POSITIVE_INFINITY
  let windowEndUs = Number.NEGATIVE_INFINITY
  let timestampedEvents = 0

  const buckets = new Map()
  const threadNameByKey = new Map()
  const processNameByPid = new Map()
  const threadNameMetadataCount = { total: 0 }

  for (const raw of events) {
    if (!isPlainObject(raw)) {
      malformedEvents += 1
      continue
    }
    const pid = isFiniteNumber(raw.pid) ? raw.pid : null
    const tid = isFiniteNumber(raw.tid) ? raw.tid : null
    const key = `${pid === null ? 'null' : pid}:${tid === null ? 'null' : tid}`

    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { key, pid, tid, events: [] }
      buckets.set(key, bucket)
    }
    bucket.events.push(raw)

    const name = typeof raw.name === 'string' ? raw.name : ''
    if (name === '') unnamedEvents += 1

    if (raw.ph === 'M' && isPlainObject(raw.args) && typeof raw.args.name === 'string') {
      if (name === 'thread_name') {
        threadNameMetadataCount.total += 1
        threadNameByKey.set(key, raw.args.name)
      } else if (name === 'process_name') {
        // keyed by pid only: a process_name metadata event lives on tid 0 of that process
        processNameByPid.set(pid === null ? 'null' : pid, raw.args.name)
      }
    }

    if (isFiniteNumber(raw.ts) && raw.ph !== 'M') {
      timestampedEvents += 1
      const dur = isFiniteNumber(raw.dur) ? raw.dur : null
      const endUs = dur !== null && dur > 0 ? raw.ts + dur : raw.ts
      if (raw.ts < windowStartUs) windowStartUs = raw.ts
      if (endUs > windowEndUs) windowEndUs = endUs
    }
  }

  const matchedThreads = [...buckets.values()]
    .filter((bucket) => threadNameByKey.get(bucket.key) === CR_RENDERER_MAIN_THREAD_NAME)
    .sort(compareThreads)
    .map((bucket) =>
      analyzeThread(bucket, {
        threadName: CR_RENDERER_MAIN_THREAD_NAME,
        processName: processNameByPid.get(bucket.pid === null ? 'null' : bucket.pid) ?? null,
      }),
    )

  const hasWindow = timestampedEvents > 0
  const durationUs = hasWindow ? windowEndUs - windowStartUs : 0

  if (events.length === 0) warnings.push('trace contains no events at all: nothing to analyse')
  if (malformedEvents > 0) warnings.push(`${malformedEvents} trace entr(ies) are not JSON objects and were ignored`)
  if (threadNameMetadataCount.total === 0 && events.length > 0) {
    warnings.push('no "thread_name" metadata events found: no thread can be identified as CrRendererMain')
  }
  if (matchedThreads.length === 0) {
    warnings.push(
      `no thread named "${CR_RENDERER_MAIN_THREAD_NAME}" found: no long task or frame pacing analysis is possible`,
    )
  }
  for (const thread of matchedThreads) warnings.push(...thread.warnings)

  const frameDataAvailable = matchedThreads.some((thread) => thread.animationFrames.dataAvailable)
  let frameUnavailableReason = null
  if (!frameDataAvailable) {
    if (matchedThreads.length === 0) {
      frameUnavailableReason = `no "${CR_RENDERER_MAIN_THREAD_NAME}" thread found, so no ${FRAME_EVENT_NAME} data exists for analysis`
    } else {
      frameUnavailableReason = matchedThreads
        .map((thread) => `thread ${thread.key}: ${thread.animationFrames.unavailableReason}`)
        .join(' | ')
    }
  }

  const summary = {
    schema: SCHEMA,
    task: TASK_ID,
    tool: {
      path: 'scripts/summarize-trace.mjs',
      runtime: `node ${process.version}`,
      dependencies: 'none (Node.js built-in modules only)',
    },
    invocation: {
      command: USAGE,
      commandLine: options.commandLine ?? commandLineFromArgv(options.argv ?? []),
      argv: Array.isArray(options.argv) ? [...options.argv] : [],
      inputPath: options.inputPath ?? null,
      outputPath: options.outputPath ?? null,
    },
    input: {
      path: options.inputPath ?? null,
      absolutePath: options.absoluteInputPath ?? null,
      bytes: isFiniteNumber(options.bytes) ? options.bytes : null,
      compression: options.compression ?? 'none',
      format,
      eventCount: events.length,
      malformedEventCount: malformedEvents,
      unnamedEventCount: unnamedEvents,
      threadNameMetadataCount: threadNameMetadataCount.total,
      access: 'read-only: the input trace is parsed in memory and never written to',
    },
    units: {
      sourceTimeUnit: 'microseconds',
      sourceTimeUnitSymbol: 'us',
      sourceNote: 'Chrome DevTools trace ts/dur are microseconds',
      derivedTimeUnit: 'milliseconds',
      derivedTimeUnitSymbol: 'ms',
      conversion: '1 ms = 1000 us (ms = us / 1000)',
      secondsProvidedFor: 'sampling durations',
    },
    sampling: {
      basis: 'min(ts) .. max(ts + dur) over non-metadata timestamped events in the trace file (all processes/threads)',
      unit: 'microseconds',
      unitSymbol: 'us',
      windowStartUs: hasWindow ? windowStartUs : null,
      windowEndUs: hasWindow ? windowEndUs : null,
      durationUs,
      durationMs: usToMs(durationUs),
      durationSeconds: usToSeconds(durationUs),
      timestampedEventCount: timestampedEvents,
      threadCount: buckets.size,
    },
    selection: {
      rule: 'ph === "M" && name === "thread_name" && args.name === "CrRendererMain"',
      matchedThreadCount: matchedThreads.length,
      matchedThreadKeys: matchedThreads.map((thread) => thread.key),
      separation:
        'each matching thread is analysed independently (keyed by pid + tid); series from different threads are never combined',
    },
    threads: matchedThreads,
    dataAvailability: {
      crRendererMainThreadFound: matchedThreads.length > 0,
      matchedThreadCount: matchedThreads.length,
      longTaskDataAvailable: matchedThreads.some((thread) => thread.longTasks.dataAvailable),
      animationFrameDataAvailable: frameDataAvailable,
      animationFrameDataUnavailableReason: frameUnavailableReason,
      fpsAssumedOrBackfilled: false,
      fpsAssumptionNote:
        'no fps value is assumed, defaulted or back-filled (in particular never a hard-coded 60) when FireAnimationFrame data is missing or insufficient',
    },
    warnings,
    notes: [
      'ts (timestamp) and dur (duration) in Chrome DevTools traces are microseconds; this report converts to milliseconds (ms = us / 1000) and to seconds for sampling durations.',
      `Long tasks: complete X or same-thread nested B/E slices named ${LONG_TASK_EVENT_NAMES.join(', ')} with dur > ${LONG_TASK_THRESHOLD_US} us; nested aliases count once. Missing supported events means unavailable, not zero.`,
      `Frame pacing: differences between consecutive "${FRAME_EVENT_NAME}" start timestamps (ts) inside a single thread; frames are never pooled across threads.`,
      'FireAnimationFrame measures callback cadence, not presented frames. Multiple callbacks can share a display frame; use the DevTools Frames track to verify presentation.',
      `Percentiles: ${PERCENTILE_METHOD}.`,
      'Sampling duration is reported as the trace-wide window (all threads) and per analysed thread; frame sampling span covers first..last frame start of that thread.',
      'When a thread has fewer than 2 frame start timestamps, frame interval statistics, over-threshold counts and fps are null with an explicit unavailableReason — they are never estimated.',
      'Metadata timestamps (often zero) are excluded from sampling windows. Chrome displayTimeUnit does not change the microsecond units of ts/dur.',
      'The input trace file is opened read-only and is never modified; the CLI refuses output paths, symlinks and hard links to the input trace.',
    ],
  }

  return summary
}

/* --------------------------------------------------------------------- CLI */

function errorPayload(code, message, extra = {}) {
  return {
    schema: ERROR_SCHEMA,
    task: TASK_ID,
    error: { code, message, ...extra },
    invocation: {
      command: USAGE,
      commandLine: commandLineFromArgv(process.argv.slice(1)),
      argv: process.argv.slice(1),
    },
  }
}

function fail(code, exitCode, message, extra) {
  process.stderr.write(`${JSON.stringify(errorPayload(code, message, extra), null, 2)}\n`)
  return exitCode
}

export function helpText() {
  return [
    `${TASK_ID} — Chrome DevTools trace summarizer`,
    '',
    'Usage:',
    `  ${USAGE}`,
    '',
    'Arguments:',
    '  <trace.json>   Chrome DevTools JSON or .json.gz export: {"traceEvents":[...]} or a bare [...] array',
    '  [out.json]     optional path for the same machine-readable JSON report',
    '',
    'Reported:',
    `  - every thread whose thread_name metadata is "${CR_RENDERER_MAIN_THREAD_NAME}" (analysed separately, never merged)`,
    `  - complete X or nested B/E RunTask / Chromium scheduler aliases longer than ${LONG_TASK_THRESHOLD_US} us (50 ms)`,
    `  - per-thread "${FRAME_EVENT_NAME}" start-to-start interval distribution (avg/p50/p95/p99/max), fps,`,
    '    and counts of intervals over 20 ms and over 33.34 ms (callback cadence, not presented-frame fps)',
    '  - sampling window and duration with explicit units',
    '',
    'The report JSON is always printed to stdout; with [out.json] it is also written to that file.',
    'The input trace is never modified. Frame data is reported as unavailable when there are too few',
    'FireAnimationFrame events — no frame rate is ever assumed (no implicit 60 fps).',
    '',
  ].join('\n')
}

function samePath(a, b) {
  try {
    if (resolve(a) === resolve(b)) return true
  } catch {
    /* fall through to realpath comparison */
  }
  try {
    if (realpathSync(a) === realpathSync(b)) return true
    const aStat = statSync(a)
    const bStat = statSync(b)
    return aStat.dev === bStat.dev && aStat.ino === bStat.ino
  } catch {
    return false
  }
}

export function main(argv = process.argv) {
  const args = argv.slice(2)
  const flags = args.filter((arg) => arg.startsWith('-'))
  const positional = args.filter((arg) => !arg.startsWith('-'))

  if (flags.includes('--help') || flags.includes('-h')) {
    process.stdout.write(helpText())
    return 0
  }
  if (flags.length > 0) {
    return fail('unknown-flag', 2, `unknown option(s): ${flags.join(', ')}; expected ${USAGE}`)
  }
  if (positional.length < 1 || positional.length > 2) {
    return fail('bad-usage', 2, `expected ${USAGE} (got ${positional.length} positional argument(s))`)
  }

  const [inputPath, outputPath = null] = positional
  const absoluteInputPath = resolve(inputPath)

  if (outputPath !== null && samePath(inputPath, outputPath)) {
    return fail(
      'output-would-overwrite-input',
      2,
      `refusing to write the report over the input trace (${absoluteInputPath}); the original trace must stay untouched`,
    )
  }

  let raw
  try {
    raw = readFileSync(absoluteInputPath)
  } catch (error) {
    return fail('input-unreadable', 1, `cannot read trace file: ${error.message}`, { inputPath })
  }

  let summary
  try {
    // Current DevTools can export gzip by default. Detect its signature rather
    // than trusting an extension; decompression never rewrites the source file.
    const compressed = raw[0] === 0x1f && raw[1] === 0x8b
    let decoded = raw
    if (compressed) {
      try { decoded = gunzipSync(raw) } catch (error) {
        throw new TraceFormatError(`trace gzip could not be decompressed: ${error.message}`, error)
      }
    }
    const parsed = parseTraceText(decoded.toString('utf8'))
    summary = summarizeTrace(parsed, {
      inputPath,
      absoluteInputPath,
      outputPath,
      bytes: raw.byteLength,
      compression: compressed ? 'gzip' : 'none',
      argv: argv.slice(1),
    })
  } catch (error) {
    const code = error instanceof TraceFormatError ? error.code : 'summarize-failed'
    return fail(code, 1, error.message, { inputPath })
  }

  const text = `${JSON.stringify(summary, null, 2)}\n`
  process.stdout.write(text)

  if (outputPath !== null) {
    try {
      writeFileSync(resolve(outputPath), text)
    } catch (error) {
      return fail('output-unwritable', 1, `cannot write report: ${error.message}`, { outputPath })
    }
    process.stderr.write(`report written to ${resolve(outputPath)}\n`)
  }

  return 0
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.exitCode = main()
}
