import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import { taskStore } from '../stores/taskStore'
import { LOCAL_DATA_CHANGE } from '../stores/migration'
import { sameSnapshot } from '../stores/sameSnapshot'
import { startVisiblePolling } from '../stores/visiblePolling'

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function mergeTask(tasks: Task[], saved: Task): Task[] {
  return [...tasks.filter(task => task.id !== saved.id), ...(saved.deletedAt ? [] : [saved])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function useSpatialTasks() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [observation, setObservation] = useState(0)
  const mounted = useRef(false)
  const busy = useRef(false)
  const readState = useRef<'loading' | 'ready' | 'error'>('loading')
  const writeRevision = useRef(0)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let active = true
    let request = 0
    let pending = false
    let again = false
    const read = async () => {
      if (pending) { again = true; return }
      pending = true
      const currentRequest = ++request
      const revision = writeRevision.current
      try {
        const rows = await taskStore.listTasks()
        // In-flight reads cannot replace a later successful local write.
        if (!active || currentRequest !== request || revision !== writeRevision.current) return
        readState.current = 'ready'
        setTasks(current => sameSnapshot(current, rows) ? current : rows)
        setLoading(false)
        setLoadError('')
      } catch (error: unknown) {
        if (!active || currentRequest !== request || revision !== writeRevision.current) return
        readState.current = 'error'
        setLoading(false)
        setLoadError(`无法读取本地任务：${errorMessage(error, '请重试')}`)
      } finally {
        pending = false
        if (active && again) { again = false; void read() }
      }
    }
    const refresh = () => { void read() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    const stopPolling = startVisiblePolling(refresh, 5000)
    window.addEventListener(LOCAL_DATA_CHANGE, refresh)
    window.addEventListener('focus', visible)
    return () => {
      active = false
      request += 1
      stopPolling()
      window.removeEventListener(LOCAL_DATA_CHANGE, refresh)
      window.removeEventListener('focus', visible)
    }
  }, [observation])

  const retry = useCallback(() => {
    readState.current = 'loading'
    setLoading(true)
    setLoadError('')
    setObservation(value => value + 1)
  }, [])

  const write = useCallback(async (operation: () => Promise<Task>, failure: string): Promise<Task> => {
    if (!mounted.current) throw new Error('任务空间已关闭，请重新打开后再试。')
    if (busy.current) throw new Error('正在保存任务，请稍候再试。')
    if (readState.current !== 'ready') {
      throw new Error(readState.current === 'error'
        ? '本地任务尚未读取成功，请先重试读取，再保存任务。'
        : '正在读取本地任务，请稍候再保存。')
    }
    busy.current = true
    setSaving(true)
    try {
      const saved = await operation()
      writeRevision.current += 1
      if (mounted.current) {
        setTasks(current => mergeTask(current, saved))
        // Refresh after the commit so even an invalidated in-flight read
        // is followed by a fresh snapshot, including changes from other tabs.
        setObservation(value => value + 1)
      }
      return saved
    } catch (error: unknown) {
      throw new Error(`${failure}：${errorMessage(error, '请保留内容后重试。')}`)
    } finally {
      busy.current = false
      if (mounted.current) setSaving(false)
    }
  }, [])

  const create = useCallback(async (input: { title: string; notes: string }): Promise<Task> => {
    const title = input.title.trim()
    const notes = input.notes.trim()
    if (!title) throw new Error('请为这粒星辰填写任务名称。')
    if (title.length > 160) throw new Error('任务名称最多 160 个字符。')
    if (notes.length > 2000) throw new Error('任务备注最多 2000 个字符。')
    return write(() => taskStore.createTask({
      title,
      notes,
      inbox: true,
      area: null,
      source: 'manual',
      leadDays: 3,
      importance: 2,
      energy: 'deep',
      context: ['anywhere'],
      status: 'todo',
    }), '任务未保存')
  }, [write])

  const setStatus = useCallback(async (id: string, status: TaskStatus): Promise<Task> => {
    return write(() => taskStore.updateTask(id, {
      status,
      doneAt: status === 'done' ? new Date().toISOString() : undefined,
    }, tasks.find(task => task.id === id)?.updatedAt), '任务状态未保存')
  }, [write, tasks])

  const reopen = useCallback(async (id: string, expectedUpdatedAt: string): Promise<Task> => {
    return write(() => taskStore.reopenTask(id, expectedUpdatedAt), '完成状态尚未撤回')
  }, [write])

  return { tasks, loading, loadError, saving, retry, create, setStatus, reopen }
}
