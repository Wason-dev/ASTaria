import { taskCollectionKey } from '../domain/taskCollections.ts'
import type { Operation, ReceiptTask } from './types.ts'

export type ReceiptEntry = { kind: 'operation'; id: string; operation: Operation }
  | { kind: 'collection'; id: string; name: string; due?: string; operations: Operation[]; tasks: ReceiptTask[] }

/** Group display only. Each durable operation retains its own undo boundary. */
export function receiptEntries(operations: Operation[]): ReceiptEntry[] {
  const entries: ReceiptEntry[] = [], groups = new Map<string, Extract<ReceiptEntry, { kind: 'collection' }>>()
  for (const operation of operations) {
    const tasks = operation.createdTasks ?? [], key = tasks[0] && taskCollectionKey(tasks[0])
    if (!key || !tasks.every(task => taskCollectionKey(task) === key)) {
      entries.push({ kind: 'operation', id: operation.id, operation }); continue
    }
    let group = groups.get(key)
    if (!group) {
      group = { kind: 'collection', id: key, name: tasks[0].collection!.trim(), due: tasks[0].due, operations: [], tasks: [] }
      groups.set(key, group); entries.push(group)
    }
    group.operations.push(operation)
    if (!operation.undoneAt) for (const task of tasks) if (!group.tasks.some(item => item.id === task.id)) group.tasks.push(task)
  }
  return entries
}
