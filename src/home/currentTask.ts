import type { Task } from '../domain/task'
import { deadlineTime } from '../workbench/deadlines'

/** Home highlights the nearest explicit deadline; focus recommendations stay separate. */
export function selectCurrentTask(tasks: readonly Task[]): Task | undefined {
  return tasks
    .filter(task => !task.deletedAt && (task.status === 'todo' || task.status === 'doing'))
    .map(task => ({ task, deadline: deadlineTime(task.due) ?? Infinity }))
    .sort((a, b) => a.deadline - b.deadline
      || Number(b.task.status === 'doing') - Number(a.task.status === 'doing')
      || b.task.importance - a.task.importance
      || a.task.createdAt.localeCompare(b.task.createdAt)
      || a.task.id.localeCompare(b.task.id))[0]?.task
}
