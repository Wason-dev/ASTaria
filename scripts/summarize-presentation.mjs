#!/usr/bin/env node
/** Chrome compositor evidence, with explicit separation from physical scanout. */
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const round = (value) => Math.round(value * 1e6) / 1e6
const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const countBy = (values) => Object.fromEntries([...new Set(values)].sort().map((value) => [value, values.filter((item) => item === value).length]))

function percentile(sorted, percent) {
  const position = (sorted.length - 1) * percent / 100
  const lo = Math.floor(position)
  return sorted[lo] + (sorted[Math.ceil(position)] - sorted[lo]) * (position - lo)
}

function stats(valuesUs) {
  if (valuesUs.length === 0) return null
  const sorted = [...valuesUs].sort((a, b) => a - b)
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length
  return {
    unit: 'ms', count: sorted.length,
    min: round(sorted[0] / 1000), mean: round(mean / 1000),
    p50: round(percentile(sorted, 50) / 1000), p95: round(percentile(sorted, 95) / 1000),
    p99: round(percentile(sorted, 99) / 1000), max: round(sorted.at(-1) / 1000),
    over20ms: valuesUs.filter((value) => value > 20000).length,
    over33_34ms: valuesUs.filter((value) => value > 33340).length,
    percentileMethod: 'R-7 linear interpolation',
  }
}

function cadence(events, identity, sequence) {
  const seen = new Set()
  const unique = [...events].sort((a, b) => a.ts - b.ts).filter((event) => {
    const key = identity(event)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.ts - b.ts)
  const intervals = unique.slice(1).map((event, index) => event.ts - unique[index].ts)
  const first = unique[0]?.ts ?? null
  const last = unique.at(-1)?.ts ?? null
  const spanUs = unique.length >= 2 ? last - first : null
  const sequences = sequence ? [...new Set(unique.map(sequence).filter(Number.isSafeInteger))].sort((a, b) => a - b) : []
  const gaps = sequences.slice(1).reduce((sum, value, index) => sum + Math.max(0, value - sequences[index] - 1), 0)
  return {
    available: intervals.length > 0,
    rawEvents: events.length, distinctEvents: unique.length, duplicatesExcluded: events.length - unique.length,
    firstTimestampUs: first, lastTimestampUs: last,
    spanSeconds: spanUs === null ? null : round(spanUs / 1e6),
    intervalMs: stats(intervals),
    recordedCadenceHz: spanUs > 0 ? round(intervals.length * 1e6 / spanUs) : null,
    sequence: sequence ? { first: sequences[0] ?? null, last: sequences.at(-1) ?? null, distinct: sequences.length, missingInternalSequenceNumbers: gaps, note: 'Sequence gaps are observations, not a count of physical monitor drops.' } : null,
  }
}

function asyncKey(event) {
  const id = event.id2?.global !== undefined
    ? `global:${event.id2.global}`
    : event.id2?.local !== undefined ? `pid:${event.pid}:local:${event.id2.local}`
      : event.id !== undefined ? `pid:${event.pid}:id:${event.id}` : null
  return id === null ? null : `${event.cat ?? ''}:${event.scope ?? ''}:${event.name}:${id}`
}

function pairPipelineReporters(events) {
  const stacks = new Map()
  const pairs = []
  let unmatchedEnds = 0
  let missingIds = 0
  for (const event of events.filter((item) => item.name === 'PipelineReporter' && finite(item.ts)).sort((a, b) => a.ts - b.ts)) {
    if (event.ph === 'X' && finite(event.dur) && event.dur >= 0) {
      pairs.push({ begin: event, endUs: event.ts + event.dur })
      continue
    }
    if (event.ph !== 'b' && event.ph !== 'e') continue
    const key = asyncKey(event)
    if (key === null) { missingIds++; continue }
    const stack = stacks.get(key) ?? []
    stacks.set(key, stack)
    if (event.ph === 'b') stack.push(event)
    else {
      const begin = stack.pop()
      if (begin) pairs.push({ begin, endUs: event.ts })
      else unmatchedEnds++
    }
  }
  return { pairs, unmatchedEnds, missingIds, unmatchedBegins: [...stacks.values()].reduce((sum, stack) => sum + stack.length, 0) }
}

function pipelineForDrawGroup(drawEvents, pairs) {
  const { pid } = drawEvents[0]
  const layerTreeId = drawEvents[0].args.layerTreeId
  const drawSequences = new Set(drawEvents.map((event) => event.args.frameSeqId))
  const activeLayer = pairs.filter(({ begin }) => begin.pid === pid && begin.args?.frame_reporter?.layer_tree_host_id === layerTreeId)
  const scoped = activeLayer.filter(({ begin }) => drawSequences.has(begin.args.frame_reporter.frame_sequence))
  const reporters = scoped.map(({ begin }) => begin.args.frame_reporter)
  const frames = new Map()
  for (const pair of scoped) {
    const reporter = pair.begin.args.frame_reporter
    // display_trace_id is a 64-bit integer that JSON.parse may round. Never
    // use it as an identity; source/sequence/layer fields are safe integers.
    const key = `${reporter.frame_source}:${reporter.frame_sequence}`
    const group = frames.get(key) ?? []
    group.push(pair)
    frames.set(key, group)
  }
  const frameGroups = [...frames.values()]
  const containsState = (group, state) => group.some(({ begin }) => begin.args.frame_reporter.state === state)
  const reportedSequences = new Set(reporters.map((reporter) => reporter.frame_sequence))
  const missing = [...drawSequences].filter((number) => !reportedSequences.has(number)).sort((a, b) => a - b)
  const sortedReported = [...reportedSequences].sort((a, b) => a - b)
  const normalPresented = scoped.filter(({ begin }) => begin.args.frame_reporter.state === 'STATE_PRESENTED_ALL' && begin.args.frame_reporter.frame_type !== 'FORKED')
  const sourceGroups = new Map()
  for (const pair of normalPresented) {
    const source = pair.begin.args.frame_reporter.frame_source
    const list = sourceGroups.get(source) ?? []
    list.push({ ...pair.begin, ts: pair.endUs })
    sourceGroups.set(source, list)
  }
  return {
    available: scoped.length > 0,
    selection: 'same renderer pid + active DrawFrame layer_tree_host_id + frame_sequence observed by DrawFrame; historical layers and out-of-window sequence numbers excluded',
    allCompletedReportersOnLayer: activeLayer.length,
    outsideObservedDrawSequences: activeLayer.length - scoped.length,
    scopedCompletedReporters: scoped.length,
    distinctSourceAndSequenceFrames: frames.size,
    rawReporterStates: countBy(reporters.map((reporter) => reporter.state ?? 'UNSPECIFIED')),
    frameTypes: countBy(reporters.map((reporter) => reporter.frame_type ?? 'UNSPECIFIED')),
    framesWithPresentedAllReport: frameGroups.filter((group) => containsState(group, 'STATE_PRESENTED_ALL')).length,
    framesWithPresentedPartialReport: frameGroups.filter((group) => containsState(group, 'STATE_PRESENTED_PARTIAL')).length,
    framesWithPartialButNoAllReport: frameGroups.filter((group) => containsState(group, 'STATE_PRESENTED_PARTIAL') && !containsState(group, 'STATE_PRESENTED_ALL')).length,
    framesWithExplicitDroppedState: scoped.length ? frameGroups.filter((group) => group.some(({ begin }) => /DROPPED/.test(begin.args.frame_reporter.state ?? ''))).length : null,
    dropInterpretation: 'Count only explicit DROPPED states in the scoped browser reporters. PRESENTED_PARTIAL / FORKED is retained separately and is not silently converted into a dropped monitor frame. A zero here does not prove physical monitor scanout.',
    highLatencyReporters: reporters.filter((reporter) => reporter.has_high_latency === true).length,
    missingContentReporters: reporters.filter((reporter) => reporter.has_missing_content === true).length,
    drawSequencesWithoutCompletedReporter: {
      count: missing.length,
      leadingBoundary: missing.filter((number) => number < (sortedReported[0] ?? Infinity)).length,
      trailingBoundary: missing.filter((number) => number > (sortedReported.at(-1) ?? -Infinity)).length,
      internal: missing.filter((number) => number > sortedReported[0] && number < sortedReported.at(-1)).length,
      note: 'Recording boundaries can omit later feedback. No completion or drop status is invented for these sequences.',
    },
    nonForkedPresentedAllPipelineLatencyMs: stats(normalPresented.map(({ begin, endUs }) => endUs - begin.ts)),
    completedPresentedReporterCadence: [...sourceGroups].map(([frameSource, list]) => ({ frameSource, semantics: 'PipelineReporter end timestamps for non-FORKED STATE_PRESENTED_ALL reports; browser pipeline completion, not hardware scanout.', ...cadence(list, (event) => `${event.args.frame_reporter.frame_source}:${event.args.frame_reporter.frame_sequence}`, (event) => event.args.frame_reporter.frame_sequence) })),
  }
}

export function summarizePresentation(parsed) {
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  if (!Array.isArray(events)) throw new TypeError('Expected a Chrome traceEvents array or bare event array')
  const valid = events.filter((event) => event && typeof event === 'object')
  const threads = new Map(valid.filter((event) => event.ph === 'M' && event.name === 'thread_name').map((event) => [`${event.pid}:${event.tid}`, event.args?.name]))
  const drawGroups = new Map()
  const presentationGroups = new Map()
  for (const event of valid) {
    if (!finite(event.ts)) continue
    if (event.name === 'DrawFrame' && ['I', 'i'].includes(event.ph) && Number.isSafeInteger(event.args?.frameSeqId) && event.args?.layerTreeId !== undefined) {
      const key = `${event.pid}:${event.tid}:${event.args.layerTreeId}`
      const group = drawGroups.get(key) ?? []
      group.push(event)
      drawGroups.set(key, group)
    }
    if (event.name === 'AnimationFrame::Presentation' && ['n', 'I', 'i'].includes(event.ph) && Number.isSafeInteger(event.args?.begin_frame_id?.sequence_number)) {
      const key = `${event.pid}:${event.tid}:${event.args.begin_frame_id.source_id}`
      const group = presentationGroups.get(key) ?? []
      group.push(event)
      presentationGroups.set(key, group)
    }
  }
  const paired = pairPipelineReporters(valid)
  const draws = [...drawGroups].map(([key, list]) => ({
    key, pid: list[0].pid, tid: list[0].tid, thread: threads.get(`${list[0].pid}:${list[0].tid}`) ?? null, layerTreeId: list[0].args.layerTreeId,
    semantics: 'DrawFrame instant (I/i): compositor draw scheduling timestamps. A draw is not by itself a presentation or physical scanout.',
    cadence: cadence(list, (event) => event.args.frameSeqId, (event) => event.args.frameSeqId),
    pipeline: pipelineForDrawGroup(list, paired.pairs),
  }))
  return {
    eventCount: events.length,
    observedPhases: Object.fromEntries(['DrawFrame', 'AnimationFrame::Presentation', 'PipelineReporter'].map((name) => [name, countBy(valid.filter((event) => event.name === name).map((event) => event.ph ?? 'UNSPECIFIED'))])),
    drawGroups: draws,
    browserPresentationGroups: [...presentationGroups].map(([key, list]) => ({
      key, pid: list[0].pid, tid: list[0].tid, thread: threads.get(`${list[0].pid}:${list[0].tid}`) ?? null, frameSource: list[0].args.begin_frame_id.source_id,
      semantics: 'AnimationFrame::Presentation nestable-async instant (n), or explicit instant. Timestamp is browser-recorded presentation feedback associated with a begin_frame_id; distinct from a FireAnimationFrame callback.',
      cadence: cadence(list, (event) => `${event.args.begin_frame_id.source_id}:${event.args.begin_frame_id.sequence_number}`, (event) => event.args.begin_frame_id.sequence_number),
    })),
    pipelinePairing: { completed: paired.pairs.length, unmatchedBegins: paired.unmatchedBegins, unmatchedEnds: paired.unmatchedEnds, missingIds: paired.missingIds, scope: 'Nestable async b/e paired by category, scope, name, and process-scoped local id or global id; reused ids handled with per-id stacks.' },
    interpretation: {
      mainThreadRafIsPresentedFrames: false,
      physicalMonitorScanoutVerified: false,
      note: 'These records establish browser compositor/presentation-feedback cadence. A headless browser can emit all of them without a physical monitor presenting the frames. Physical-display verification requires a headed/native capture with its display context documented.',
      timestampUnits: 'Chrome ts/dur are microseconds. All reported intervals/latencies are milliseconds.',
      window: 'Cadence uses first-to-last timestamps in each selected series, not the global trace minimum, which can include retrospectively emitted historical PipelineReporter events.',
    },
  }
}

function sameFile(left, right) {
  if (resolve(left) === resolve(right)) return true
  try {
    if (realpathSync(left) === realpathSync(right)) return true
    const a = statSync(left), b = statSync(right)
    return a.dev === b.dev && a.ino === b.ino
  } catch { return false }
}

export function main(argv = process.argv.slice(2)) {
  const inputs = []
  let output = null
  let captureMode = 'unknown'
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--out') output = argv[++index]
    else if (argv[index] === '--capture-mode') captureMode = argv[++index]
    else if (argv[index].startsWith('-')) throw new Error(`Unknown option ${argv[index]}`)
    else inputs.push(argv[index])
  }
  if (!inputs.length || !['headless', 'headed', 'unknown'].includes(captureMode) || output === undefined) {
    throw new Error('Usage: node scripts/summarize-presentation.mjs trace.json[.gz] ... [--capture-mode headless|headed|unknown] [--out summary.json]')
  }
  if (output && inputs.some((input) => sameFile(input, output))) throw new Error('Output aliases an input trace; refusing to overwrite it')
  const reports = inputs.map((path) => {
    const raw = readFileSync(path)
    const gzip = raw[0] === 0x1f && raw[1] === 0x8b
    const parsed = JSON.parse((gzip ? gunzipSync(raw) : raw).toString('utf8').replace(/^\uFEFF/, ''))
    return { input: { path: resolve(path), bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex'), compression: gzip ? 'gzip' : 'none', access: 'read only; source bytes never modified' }, ...summarizePresentation(parsed) }
  })
  const result = { schema: 'astaria.presentation-evidence/v1', runtime: process.version, invocation: argv, captureMode, captureModeSource: argv.includes('--capture-mode') ? '--capture-mode supplied by operator; not inferred from absent headless markers' : 'unknown; no capture-mode flag supplied', physicalMonitorScanoutVerified: false, reports }
  const text = JSON.stringify(result, null, 2) + '\n'
  if (output) writeFileSync(output, text)
  process.stdout.write(text)
  return result
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
