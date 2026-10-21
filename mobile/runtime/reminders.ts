import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import type { LocalNotificationsPlugin, LocalNotificationSchema, PendingLocalNotificationSchema } from '@capacitor/local-notifications'
import type { Task } from '../../src/domain/task.ts'
import type { PlannerState } from '../../src/planner/types.ts'
import type { Preferences } from '../../src/xixi/preferences.ts'
// @ts-expect-error The shared pure JavaScript projection has independent contract tests.
import { buildReminderPlan, hash } from '../../server/reminderPlan.mjs'

export type ReminderSnapshot = { tasks: Task[]; planner: PlannerState; preferences: Pick<Preferences, 'notifications'> }
export type MobileReminderStatus = {
  supported: boolean; platform: 'ios' | 'android' | 'web-preview'; enabled: boolean
  authorization: number; count: number; through: number | null; omitted: number; error: string | null
}
type Options = {
  readSnapshot: () => Promise<ReminderSnapshot>
  readEnabled: () => Promise<boolean>
  saveEnabled: (value: boolean) => Promise<void>
}
type Dependencies = {
  platform?: Pick<typeof Capacitor, 'isNativePlatform' | 'getPlatform' | 'isPluginAvailable'>
  notifications?: Pick<LocalNotificationsPlugin, 'checkPermissions' | 'requestPermissions' | 'getPending' | 'cancel' | 'schedule'>
  now?: () => Date
}
type Entry = { id: string; title: string; body: string; at: number }
type Plan = { entries: Entry[]; omitted: number }
const OWNER = 'astaria.reminders.v1'
const permissionIssue = '请在系统设置中允许 ASTaria 通知，再重新同步提醒'
const owned = (entry: PendingLocalNotificationSchema) => entry.extra?.owner === OWNER
const triggerTime = (entry: PendingLocalNotificationSchema) => new Date(entry.schedule?.at ?? NaN).getTime() / 1000
const matches = (actual: PendingLocalNotificationSchema, expected: LocalNotificationSchema) =>
  actual.id === expected.id && actual.title === expected.title && actual.body === expected.body
  && owned(actual) && actual.extra.kind === expected.extra.kind && actual.extra.key === expected.extra.key
  && actual.extra.fingerprint === expected.extra.fingerprint && actual.extra.at === expected.extra.at
  && triggerTime(actual) === expected.extra.at && !actual.schedule?.repeats && !actual.schedule?.every

function notification(entry: Entry, kind: 'plan' | 'test', occupied: Set<number>): LocalNotificationSchema {
  // The logical plan id stays compatible with desktop. The native id changes
  // with content AND trigger time, so rescheduling cannot leave the old alarm.
  const fingerprint: string = hash(JSON.stringify([entry.id, entry.title, entry.body, entry.at]))
  let salt = 0, id: number
  do { id = (parseInt(hash(`${fingerprint}:${salt++}`).slice(0, 8), 16) & 0x7fffffff) || 1 } while (occupied.has(id))
  occupied.add(id)
  return {
    id, title: entry.title, body: entry.body,
    schedule: { at: new Date(entry.at * 1000), repeats: false },
    // Capacitor 8.3 otherwise opens Android's exact-alarm settings implicitly.
    // Ordinary alarms need no extra permission and may be delayed by Android.
    isExactNotification: false,
    extra: { owner: OWNER, kind, key: entry.id, fingerprint, at: entry.at },
  }
}

/** No polling or app listeners: the host calls scheduleRefresh on mutation/foreground. */
export function createMobileReminders(options: Options, dependencies: Dependencies = {}) {
  const platform = dependencies.platform ?? Capacitor, native = dependencies.notifications ?? LocalNotifications
  const now = dependencies.now ?? (() => new Date())
  const name = platform.getPlatform()
  const device = platform.isNativePlatform() && (name === 'ios' || name === 'android')
  const state: MobileReminderStatus = {
    supported: device && platform.isPluginAvailable('LocalNotifications'), platform: device ? name : 'web-preview',
    enabled: false, authorization: 0, count: 0, through: null, omitted: 0, error: null,
  }
  let loaded = false, closed = false, revision = 0, choiceRevision = 0, tail: Promise<unknown> = Promise.resolve()
  let scheduled: Promise<MobileReminderStatus> | undefined
  const statusValue = () => ({ ...state })
  const clearCount = () => { state.count = 0; state.through = null; state.omitted = 0 }
  const current = (version: number) => !closed && version === revision
  const load = async () => {
    if (!loaded) { state.enabled = await options.readEnabled() === true; loaded = true }
  }
  const supported = () => {
    if (!state.supported) throw new Error(device ? '手机通知组件尚未就绪，请重新打开或安装当前 App' : '浏览器预览不支持系统预约提醒，请使用 iOS 或 Android App')
  }
  const checkPermission = async () => {
    const result = await native.checkPermissions()
    state.authorization = result.display === 'granted' ? 2 : result.display === 'denied' ? 1 : 0
    return result.display === 'granted'
  }
  const pending = async () => {
    const result = await native.getPending()
    if (!Array.isArray(result.notifications)) throw new Error('系统预约列表未能读取，请重新同步提醒')
    return result.notifications
  }
  const cancel = async (entries: PendingLocalNotificationSchema[]) => {
    if (entries.length) await native.cancel({ notifications: entries.map(({ id }) => ({ id })) })
  }
  const sync = async (version: number) => {
    if (!current(version)) return
    clearCount()
    if (!state.supported) { state.enabled = false; state.error = device ? '手机通知组件尚未就绪' : null; return }
    const granted = await checkPermission()
    const plan: Plan = state.enabled && granted ? buildReminderPlan(await options.readSnapshot(), now()) : { entries: [], omitted: 0 }
    if (!current(version)) return
    let actual = await pending()
    if (!current(version)) return
    const occupied = new Set(actual.filter(entry => !owned(entry) || entry.extra.kind === 'test').map(entry => entry.id))
    const expected = plan.entries.map(entry => notification(entry, 'plan', occupied))
    // Preserve other features' records, even if an id collides with our hash.
    await cancel(actual.filter(entry => owned(entry) && (!state.enabled || !granted
      || (entry.extra.kind === 'test' ? triggerTime(entry) <= now().getTime() / 1000 : !expected.some(value => matches(entry, value))))))
    actual = await pending()
    if (!current(version)) return
    if (actual.some(entry => owned(entry) && (!state.enabled || !granted
      || (entry.extra.kind !== 'test' && !expected.some(value => matches(entry, value)))))) {
      throw new Error('旧提醒未能取消，尚未预约新的时间；请重新同步提醒')
    }
    if (state.enabled && !granted) throw new Error(permissionIssue)
    const missing = expected.filter(entry => entry.extra.at > now().getTime() / 1000 && !actual.some(value => matches(value, entry)))
    if (missing.length) {
      if (name === 'ios' && actual.length + missing.length > 64) throw new Error('系统预约数量已达上限，请稍后重新同步提醒')
      // Recheck immediately before schedule, which can implicitly request
      // display permission in recent plugin versions. Never schedule ungranted.
      if (!await checkPermission()) throw new Error(permissionIssue)
      if (!current(version)) return
      const future = missing.filter(entry => entry.extra.at > now().getTime() / 1000)
      if (future.length) await native.schedule({ notifications: future })
    }
    actual = await pending()
    if (!current(version)) return
    const remaining = expected.filter(entry => entry.extra.at > now().getTime() / 1000)
    const plans = actual.filter(entry => owned(entry) && entry.extra.kind !== 'test' && triggerTime(entry) > now().getTime() / 1000)
    if (plans.length !== remaining.length || remaining.some(entry => !plans.some(value => matches(value, entry)))) {
      throw new Error('系统预约与最新安排不一致，请重新同步提醒')
    }
    state.count = remaining.length; state.through = remaining.at(-1)?.extra.at ?? null; state.omitted = plan.omitted; state.error = null
  }
  // Serialize native mutations and invalidate older snapshot reads immediately.
  // Each queued operation reads a fresh snapshot; a failed operation cannot
  // poison the queue or publish a previous count as a successful replacement.
  const run = <T>(operation: (version: number) => Promise<T>): Promise<T> => {
    const version = ++revision
    const result = tail.then(async () => {
      if (closed) throw new Error('手机提醒服务已停止')
      await load()
      return operation(version)
    }).catch(reason => {
      clearCount()
      state.error = reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message) ? reason.message : '系统提醒操作未完成，请重新同步'
      throw new Error(state.error)
    })
    tail = result.catch(() => {})
    return result
  }
  const settledStatus = async () => {
    // An API read/toggle that is superseded waits outside the native queue for
    // its successor. Never return an unverified zero count between two plans.
    let completion: Promise<unknown>
    do { completion = tail; await completion } while (completion !== tail)
    return statusValue()
  }
  const refresh = () => run(async version => { await sync(version) }).then(settledStatus, settledStatus)
  return {
    status: refresh, refresh,
    async setEnabled(value: boolean) {
      if (typeof value !== 'boolean') throw new Error('提醒开关无效')
      const choice = ++choiceRevision
      const latestChoice = () => !closed && choice === choiceRevision
      return run(async () => {
        supported()
        if (value && latestChoice()) {
          if (!await checkPermission()) {
            if (!latestChoice()) return statusValue()
            const result = await native.requestPermissions()
            state.authorization = result.display === 'granted' ? 2 : result.display === 'denied' ? 1 : 0
            if (result.display !== 'granted') throw new Error(permissionIssue)
          }
        }
        if (!latestChoice()) return statusValue()
        await options.saveEnabled(value)
        state.enabled = value
        // A foreground refresh while the permission dialog closes must not
        // discard the user's choice. Only a newer toggle can supersede it.
        if (latestChoice()) await sync(revision)
        return statusValue()
      }).then(settledStatus, settledStatus)
    },
    async test() {
      return run(async version => {
        supported()
        if (!state.enabled || !await checkPermission()) throw new Error('请先开启系统提醒并允许通知')
        await sync(version)
        if (!current(version)) throw new Error('提醒安排已变化，请重新发送测试提醒')
        let actual = await pending()
        await cancel(actual.filter(entry => owned(entry) && entry.extra.kind === 'test'))
        actual = await pending()
        if (actual.some(entry => owned(entry) && entry.extra.kind === 'test')) throw new Error('旧测试提醒未能取消，请重试')
        if (name === 'ios' && actual.length >= 64) throw new Error('系统预约数量已达上限，未添加测试提醒')
        const entry = notification({ id: 'astaria.test', title: 'ASTaria 测试提醒', body: '系统提醒已连接，可返回 ASTaria 查看安排', at: Math.floor(now().getTime() / 1000) + 5 }, 'test', new Set(actual.map(value => value.id)))
        if (!await checkPermission()) throw new Error(permissionIssue)
        if (!current(version)) throw new Error('提醒安排已变化，请重新发送测试提醒')
        await native.schedule({ notifications: [entry] })
        actual = await pending()
        if (!current(version)) throw new Error('提醒安排已变化，请重新发送测试提醒')
        if (!actual.some(value => matches(value, entry))) throw new Error('测试提醒未能确认预约，请重试')
        return { message: '测试提醒已预约，计划约 5 秒后提示；实际送达取决于系统通知与后台设置' }
      })
    },
    scheduleRefresh() {
      if (closed) return Promise.resolve(statusValue())
      // Merge notifications from one mutation/foreground burst without a timer
      // or a background loop. In-flight reads become obsolete immediately.
      ++revision
      scheduled ??= Promise.resolve().then(() => { scheduled = undefined; return refresh() })
      return scheduled
    },
    dispose() { closed = true; ++revision; ++choiceRevision },
  }
}
