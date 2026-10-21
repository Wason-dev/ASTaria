import { randomUUID } from './portable.mjs'
import { ValidationError, knownKeys } from './validation.mjs'
import { blocksForDay, routinesForDay } from '../src/planner/model.ts'

const DAY = 86_400_000
const MAX_ROWS = 1000
const MAX_DAYS = 366 // Inclusive calendar dates, including excluded occurrences.
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const fail = (message, status = 400) => { throw new ValidationError(message, status) }
const overlap = (a, b) => a.start < b.end && b.start < a.end
const pad = value => String(value).padStart(2, '0')
const dateText = value => `${String(value.year).padStart(4, '0')}-${pad(value.month)}-${pad(value.day)}`
const clockText = value => `${pad(value.hour)}:${pad(value.minute)}`
const wallMillis = value => Date.parse(`${dateText(value)}T${clockText(value)}:${pad(value.second)}Z`)

function validDate(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/u.test(value)) fail('日期需要是有效的 YYYY-MM-DD（1000–9999 年）')
  const instant = Date.parse(`${value}T00:00:00Z`)
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) fail(`日期不存在：${value}`)
  return instant
}

function field(value, label, empty = false, max = 160) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value)) {
    fail(`${label}${empty ? '' : '不能为空，且'}最多 ${max} 个字符，不能含控制字符`)
  }
  return value.trim()
}

/** Intl supplies IANA tzdata; resolve by round-tripping *all* adjacent offsets.
 * Sampling both sides of the date also handles half-hour DST and skipped dates.
 * Never let Date's host-zone constructor choose an overlap/gap interpretation.
 */
function timezones() {
  const formatters = new Map(), offsetsByDate = new Map()
  const formatter = zone => {
    if (typeof zone !== 'string' || !zone || zone.length > 100 || /^[+-]/u.test(zone)) fail('timezone / TZID 必须是 Intl 支持的 IANA 时区名称')
    if (!formatters.has(zone)) {
      try {
        formatters.set(zone, new Intl.DateTimeFormat('en-GB-u-ca-iso8601-nu-latn', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }))
      } catch { fail(`不支持的 IANA 时区：${zone}`) }
    }
    return formatters.get(zone)
  }
  const parts = (instant, zone) => Object.fromEntries(formatter(zone).formatToParts(instant)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
  const resolve = (wall, zone) => {
    formatter(zone)
    const naive = wallMillis(wall), key = `${zone}/${dateText(wall)}`
    if (!offsetsByDate.has(key)) {
      const offsets = new Set()
      const midnight = validDate(dateText(wall))
      // IANA transitions have stable offsets on either side. The four-day
      // window includes both even for a 24-hour international-date-line jump.
      for (let hour = -48; hour <= 48; hour += 6) {
        const probe = midnight + hour * 3_600_000
        offsets.add(wallMillis(parts(probe, zone)) - probe)
      }
      offsetsByDate.set(key, offsets)
    }
    const candidates = [...offsetsByDate.get(key)].map(offset => naive - offset)
      .filter(instant => wallMillis(parts(instant, zone)) === naive)
    if (candidates.length !== 1) fail(`${dateText(wall)} ${clockText(wall)} 在 ${zone} ${candidates.length ? '有夏令时歧义' : '不存在（时区跳变）'}；请提供可唯一确定的时刻`)
    return candidates[0]
  }
  return { formatter, parts, resolve }
}

function splitOutsideQuotes(value, separator) {
  const result = []
  let quoted = false, from = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '"') quoted = !quoted
    if (value[index] === separator && !quoted) { result.push(value.slice(from, index)); from = index + 1 }
  }
  if (quoted) fail('ICS 参数引号未闭合')
  result.push(value.slice(from))
  return result
}

function property(line) {
  // The first colon outside a quoted parameter separates the value. Subsequent
  // colons (e.g. in a URL or SUMMARY) are ordinary text and are never fetched.
  let quoted = false, colon = -1
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted
    if (line[index] === ':' && !quoted) { colon = index; break }
  }
  if (colon < 1) fail('ICS 内容行缺少属性名或冒号')
  const [rawName, ...parameters] = splitOutsideQuotes(line.slice(0, colon), ';')
  const name = rawName.toUpperCase(), params = new Map()
  if (!/^[A-Z0-9-]+$/u.test(name)) fail('ICS 属性名无效')
  for (const parameter of parameters) {
    const equals = parameter.indexOf('=')
    const key = parameter.slice(0, equals).toUpperCase()
    let value = parameter.slice(equals + 1)
    if (equals < 1 || !/^[A-Z0-9-]+$/u.test(key) || !value || params.has(key)) fail('ICS 参数无效或重复')
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    params.set(key, value)
  }
  return { name, params, value: line.slice(colon + 1) }
}

function calendar(text) {
  if (typeof text !== 'string' || !text.trim()) fail('请选择有内容的 ICS 文件')
  if (text.length > 1024 * 1024 || new TextEncoder().encode(text).byteLength > 1024 * 1024) fail('ICS 文件不能超过 1 MiB', 413)
  if (/\r(?!\n)/u.test(text) || text.includes('\0')) fail('ICS 换行或字符编码无效')
  const lines = text.replace(/^\uFEFF/u, '').replace(/\r?\n[ \t]/gu, '').split(/\r?\n/u)
  const events = [], stack = []
  let current, started = false, finished = false, version = false, method = false
  for (const line of lines) {
    if (!line) continue
    const prop = property(line), { name, value } = prop
    if (name === 'BEGIN') {
      if (prop.params.size) fail('ICS BEGIN 不支持参数')
      const component = value.toUpperCase()
      if (component === 'VCALENDAR' && !started && !stack.length) { started = true }
      else if (component === 'VEVENT' && stack.join('/') === 'VCALENDAR') {
        current = new Map()
      } else if (component === 'VALARM' && stack.join('/') === 'VCALENDAR/VEVENT') {
        // Alarms have no schedule effect; import never schedules/fetches them.
      } else fail(`暂不支持 ICS 组件 ${component}；请导出只含 VEVENT 和 IANA TZID 的课表（不含自定义 VTIMEZONE）`)
      stack.push(component)
      continue
    }
    if (name === 'END') {
      if (prop.params.size || stack.at(-1) !== value.toUpperCase()) fail('ICS 组件未正确闭合')
      const ended = stack.pop()
      if (ended === 'VEVENT') {
        events.push(current); current = undefined
        if (events.length > MAX_ROWS) fail('ICS 事件数不能超过 1000', 413)
      }
      if (ended === 'VCALENDAR') finished = true
      continue
    }
    if (!stack.length || finished) fail('ICS 内容应位于单个 VCALENDAR 中')
    if (stack.at(-1) === 'VALARM') continue
    if (['RDATE', 'RECURRENCE-ID', 'EXRULE'].includes(name)) fail(`暂不支持 ${name}，不能安全导入这份 ICS；请先导出独立事件`)
    if (current) {
      if (name === 'DURATION') fail('暂不支持 DURATION，请为每项课程提供明确的 DTEND')
      if (name === 'STATUS' && !['CONFIRMED', 'TENTATIVE'].includes(value.toUpperCase())) fail('不导入已取消或状态不明的事件，请先整理 ICS')
      const values = current.get(name) ?? []
      values.push(prop); current.set(name, values)
    } else if (name === 'VERSION') {
      if (version || value !== '2.0') fail('只支持 VERSION:2.0 的 ICS')
      version = true
    } else if (name === 'METHOD') {
      if (method || value.toUpperCase() !== 'PUBLISH') fail('只支持发布课表，不支持邀请、取消或更新日历消息')
      method = true
    }
  }
  if (!started || !finished || stack.length || !version || !events.length) fail('ICS 需要完整的 VCALENDAR、VERSION:2.0 和至少一个 VEVENT')
  return events
}

function one(event, name, required = false) {
  const values = event.get(name) ?? []
  if (values.length > 1 || (required && !values.length)) fail(`VEVENT 需要${required ? '且只能有' : '最多'}一个 ${name}`)
  return values[0]
}

function decoded(prop, label, required = false, max = 160) {
  if (!prop) return required ? fail(`${label}不能为空`) : ''
  if ([...prop.params].some(([key, value]) => key !== 'LANGUAGE' && !(key === 'VALUE' && value.toUpperCase() === 'TEXT'))) fail(`${label}包含不支持的编码参数`)
  let result = ''
  for (let index = 0; index < prop.value.length; index++) {
    const character = prop.value[index]
    if (character !== '\\') { result += character; continue }
    const escaped = prop.value[++index]
    if (escaped === 'n' || escaped === 'N') result += '\n'
    else if (['\\', ',', ';'].includes(escaped)) result += escaped
    else fail(`${label}含无效的 ICS 文本转义`)
  }
  return field(result, label, !required, max)
}

function dateTime(prop, userZone, zones, { boundary = false } = {}) {
  const { value, params } = prop
  if (params.get('VALUE')?.toUpperCase() === 'DATE' || /^\d{8}$/u.test(value)) fail('全天事件没有钟点，不能作为固定课导入；请补齐 DTSTART / DTEND 的具体时刻')
  if ([...params].some(([key, val]) => key !== 'TZID' && !(key === 'VALUE' && val.toUpperCase() === 'DATE-TIME'))) fail('日期时间包含不支持的参数')
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/u.exec(value)
  if (!match) fail(`无效的 ICS 日期时间：${value}`)
  const [, year, month, day, hour, minute, second, utc] = match
  const wall = { year: +year, month: +month, day: +day, hour: +hour, minute: +minute, second: +second }
  validDate(dateText(wall))
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) fail('ICS 时刻超出范围（不支持闰秒）')
  if (!boundary && wall.second !== 0) fail('日程仅支持分钟精度，请先把课程起止时刻调整到整分钟')
  if (utc && params.has('TZID')) fail('UTC 的 Z 时间不能同时指定 TZID')
  const kind = utc ? 'utc' : params.has('TZID') ? 'zoned' : 'floating'
  const zone = utc ? 'UTC' : params.get('TZID') ?? userZone
  const instant = utc ? wallMillis(wall) : zones.resolve(wall, zone)
  return { wall, zone, kind, instant }
}

function rule(prop, start, userZone, zones) {
  if (!prop) return null
  if (prop.params.size) fail('RRULE 不支持参数')
  const values = new Map()
  for (const part of prop.value.toUpperCase().split(';')) {
    const match = /^([A-Z]+)=([^=]+)$/u.exec(part)
    if (!match || values.has(match[1])) fail('RRULE 格式无效或含重复规则')
    values.set(match[1], match[2])
  }
  if ([...values.keys()].some(key => !['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL', 'WKST'].includes(key)) || values.get('FREQ') !== 'WEEKLY') fail('只支持 RRULE FREQ=WEEKLY、INTERVAL=1/2、BYDAY、WKST 及 COUNT 或 UNTIL；其他规则请导出为独立事件')
  const interval = values.get('INTERVAL') ?? '1'
  if (!['1', '2'].includes(interval)) fail('周重复只支持 INTERVAL=1 或 2')
  if (values.has('COUNT') === values.has('UNTIL')) fail('周重复必须有且仅有 COUNT 或 UNTIL 终点；不导入无限重复课表')
  const firstDay = new Date(validDate(dateText(start.wall))).getUTCDay()
  const days = (values.get('BYDAY') ?? WEEKDAYS[firstDay]).split(',')
  if (days.some(day => !WEEKDAYS.includes(day)) || new Set(days).size !== days.length) fail('BYDAY 仅支持不重复的 MO,TU,WE,TH,FR,SA,SU，不支持序号')
  if (!days.includes(WEEKDAYS[firstDay])) fail('DTSTART 与 BYDAY 不一致，无法可靠解释重复起点')
  const weekStart = values.get('WKST') ?? 'MO'
  if (!WEEKDAYS.includes(weekStart)) fail('WKST 星期无效')
  let count, until, untilDate
  if (values.has('COUNT')) {
    if (!/^[1-9]\d*$/u.test(values.get('COUNT'))) fail('COUNT 必须为正整数')
    count = Number(values.get('COUNT'))
    if (!Number.isSafeInteger(count) || count > MAX_ROWS) fail('COUNT 不能超过 1000', 413)
  } else {
    until = dateTime({ value: values.get('UNTIL'), params: new Map() }, userZone, zones, { boundary: true })
    if ((start.kind === 'floating') !== (until.kind === 'floating')) fail('浮动 DTSTART 的 UNTIL 需为浮动时间；TZID / UTC 的 UNTIL 需使用 Z 时间')
    if (until.instant < start.instant) fail('UNTIL 不能早于 DTSTART')
    untilDate = validDate(dateText(zones.parts(until.instant, start.zone)))
    if (untilDate - validDate(dateText(start.wall)) >= MAX_DAYS * DAY) fail('重复规则的日期跨度不能超过 366 天', 413)
  }
  return { interval: Number(interval), days, weekStart: WEEKDAYS.indexOf(weekStart), count, until, untilDate }
}

/** Pure preview: no database, model, key, network, URL or attachment access. */
export function previewIcsTimetable(input) {
  knownKeys(input, ['text', 'timezone'], 'ICS 预览')
  const zones = timezones()
  zones.formatter(input.timezone)
  const rows = []
  let expanded = 0, earliest = Infinity, latest = -Infinity
  const span = date => {
    const instant = validDate(date)
    earliest = Math.min(earliest, instant); latest = Math.max(latest, instant)
    if (latest - earliest >= MAX_DAYS * DAY) fail('整份课表的日期跨度不能超过 366 天', 413)
  }
  const events = calendar(input.text)
  const uids = new Set()
  for (const event of events) {
    const uid = one(event, 'UID')?.value
    if (uid && uids.has(uid)) fail('存在相同 UID 的事件版本；请先合并更新或导出独立事件')
    if (uid) uids.add(uid)
    const subject = decoded(one(event, 'SUMMARY', true), '科目', true)
    const location = decoded(one(event, 'LOCATION'), '地点')
    const note = decoded(one(event, 'DESCRIPTION'), '预览备注', false, 4000)
    const start = dateTime(one(event, 'DTSTART', true), input.timezone, zones)
    const end = dateTime(one(event, 'DTEND', true), input.timezone, zones)
    if (end.instant <= start.instant || end.instant - start.instant >= DAY) fail('结束应晚于开始且不足 24 小时；跨日课程请先拆分')
    const repeating = rule(one(event, 'RRULE'), start, input.timezone, zones)
    if (repeating && (start.kind !== end.kind || start.zone !== end.zone)) fail('重复课程的 DTSTART / DTEND 必须使用同一种时区表示')
    const excluded = new Set()
    for (const prop of event.get('EXDATE') ?? []) {
      for (const value of prop.value.split(',')) {
        const exception = dateTime({ ...prop, value }, input.timezone, zones)
        if (exception.kind !== start.kind || exception.zone !== start.zone) fail('EXDATE 必须与 DTSTART 使用相同的时间类型和 TZID')
        excluded.add(exception.instant)
        if (excluded.size > MAX_ROWS) fail('EXDATE 不能超过 1000 项', 413)
      }
    }
    const add = (from, to) => {
      if (++expanded > MAX_ROWS) fail('整份课表展开不能超过 1000 次（含 EXDATE 排除项）', 413)
      const localStart = zones.parts(from, input.timezone), localEnd = zones.parts(to, input.timezone)
      const date = dateText(localStart)
      span(date); span(dateText(localEnd))
      if (excluded.has(from)) return
      if (date !== dateText(localEnd) || from >= to || clockText(localStart) >= clockText(localEnd)) fail(`「${subject}」转换到 ${input.timezone} 后跨日或时间顺序不成立，请先拆分`)
      if (localStart.second || localEnd.second) fail('转换后的课程不是整分钟，无法精确保存在日程中')
      // A UTC timestamp can be unique while its displayed wall time is not.
      // Day events cannot retain offsets, so reject that loss of information too.
      if (zones.resolve(localStart, input.timezone) !== from || zones.resolve(localEnd, input.timezone) !== to) fail('转换后的时刻无法唯一保存在日程中')
      rows.push({ id: randomUUID(), date, start: clockText(localStart), end: clockText(localEnd), subject, location, note })
    }
    if (!repeating) { add(start.instant, end.instant); continue }
    const first = validDate(dateText(start.wall))
    // With DTEND, RFC 5545 repeats the exact elapsed duration, not an end
    // wall-clock that would silently shorten/lengthen on a DST transition.
    const duration = end.instant - start.instant
    const anchor = first - ((new Date(first).getUTCDay() - repeating.weekStart + 7) % 7) * DAY
    let occurrences = 0, complete = false
    for (let offset = 0; offset < MAX_DAYS; offset++) {
      const day = first + offset * DAY, weekday = new Date(day).getUTCDay()
      if (repeating.untilDate !== undefined && day > repeating.untilDate) { complete = true; break }
      if (Math.floor((day - anchor) / (7 * DAY)) % repeating.interval || !repeating.days.includes(WEEKDAYS[weekday])) continue
      const [year, month, date] = new Date(day).toISOString().slice(0, 10).split('-').map(Number)
      const from = zones.resolve({ ...start.wall, year, month, day: date }, start.zone)
      if (repeating.until && from > repeating.until.instant) { complete = true; break }
      add(from, from + duration)
      occurrences++ // COUNT is evaluated before EXDATE, as required by RFC 5545.
      if (occurrences === repeating.count) { complete = true; break }
    }
    if (!complete && repeating.count) fail('COUNT 所需的重复跨度超过 366 天', 413)
  }
  if (!rows.length) fail('这份课表没有可导入的课程（可能全部被 EXDATE 排除）')
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.subject.localeCompare(b.subject))
  return { draft: { rows, timezone: input.timezone } }
}

function editedRow(input) {
  knownKeys(input, ['id', 'date', 'start', 'end', 'subject', 'location', 'note'], '课程行')
  const id = field(input.id, '草稿标识', false, 200)
  validDate(input.date)
  for (const clock of [input.start, input.end]) if (typeof clock !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(clock)) fail('课程起止时刻需要有效的 HH:mm')
  if (input.start >= input.end) fail('结束时刻应晚于开始时刻；跨日课程请先拆分')
  return { id, date: input.date, start: input.start, end: input.end,
    subject: field(input.subject, '科目'), location: field(input.location ?? '', '地点', true), note: field(input.note ?? '', '预览备注', true, 4000) }
}

/** Synchronous SQLite transaction: validate latest state and every selected row,
 * then use the receipt helper, which advances the revision for each event. */
export function confirmIcsTimetable(db, input) {
  knownKeys(input, ['rows', 'expectedRevision'], 'ICS 确认')
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > MAX_ROWS) fail('请选择 1–1000 行课程', input.rows?.length > MAX_ROWS ? 413 : 400)
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('expectedRevision 必须是有效的日程版本')
  const rows = input.rows.map(editedRow)
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail('选中的草稿行标识重复')
  const dates = rows.map(row => validDate(row.date))
  if (Math.max(...dates) - Math.min(...dates) >= MAX_DAYS * DAY) fail('选中课程的日期跨度不能超过 366 天', 413)
  return db.transaction(() => {
    let state = db.getPlanner()
    if (state.revision !== input.expectedRevision) fail('日程已在其他窗口更新，请重新核对日程后再确认；草稿已保留', 409)
    if (!Number.isSafeInteger(state.revision + rows.length)) fail('日程版本超出范围', 409)
    if ((state.dayEvents ?? []).length + rows.length > 3000) fail('导入后单日活动不能超过 3000 条，请先整理已有安排', 413)
    const occupied = new Map(), tasks = db.listTasks(), zones = timezones()
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    for (const row of rows) {
      // The planner stores local, minute-resolution clocks. Validate edited
      // clocks against its runtime zone as well as the preview's source zone.
      for (const clock of [row.start, row.end]) dateTime({ value: `${row.date.replaceAll('-', '')}T${clock.replace(':', '')}00`, params: new Map() }, zone, zones)
      if (!occupied.has(row.date)) occupied.set(row.date, [
        ...routinesForDay(state, row.date).filter(item => item.enabled && item.kind !== 'available'),
        ...state.blocks.filter(item => item.date === row.date),
        ...blocksForDay(state, tasks, row.date),
      ])
      const conflict = occupied.get(row.date).find(item => overlap(row, item))
      if (conflict) fail(`${row.date} ${row.start}–${row.end}「${row.subject}」与已有安排或本批课程重复 / 时间重叠，请调整或取消选择`, 409)
      occupied.get(row.date).push(row)
    }
    // DESCRIPTION is preview-only. items is a carrying checklist, not notes.
    const events = rows.map(row => ({ id: randomUUID(), title: row.subject, date: row.date, start: row.start, end: row.end, location: row.location, items: [] }))
    if (typeof db.applyCalendarImport !== 'function') fail('本机服务尚不支持可撤销日历导入，请更新后重试', 503)
    const result = db.applyCalendarImport(events, state.revision)
    state = result?.state
    const operation = result?.operation
    if (!state || !operation || typeof operation.id !== 'string' || !operation.id || operation.undoable !== true || operation.kind !== 'planner') fail('导入回执不完整，已撤销本批导入', 409)
    state = db.getPlanner()
    if (state.revision !== input.expectedRevision + events.length || events.some(event => {
      const saved = state.dayEvents?.find(item => item.id === event.id)
      return !saved || ['title', 'date', 'start', 'end', 'location'].some(key => saved[key] !== event[key]) || JSON.stringify(saved.items) !== JSON.stringify(event.items)
    })) fail('未能核对完整保存结果，已撤销本批导入', 409)
    return { state, importedCount: events.length, importedIds: events.map(event => event.id), operation }
  })
}
