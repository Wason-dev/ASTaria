/** Resolve the legacy-profile migration before writing any new default settings. */
export function readOnboarding(db) {
  const completed = db.getPreference('onboarding-completed')
  if (completed !== null) return { completed: completed === true }
  const companion = db.getCompanionState()
  const used = db.getPreference('app') !== null || db.getPreference('model-connection') !== null
    || db.listTasks({ includeDeleted: true }).length > 0 || db.getPlanner().blocks.length > 0
    || db.listEvents().length > 0 || db.listAssignments().length > 0
    || db.listConversations().some(conversation => db.listMessages(conversation.id, { limit: 1 }).length > 0)
    || ['handoffs', 'wishes', 'freeTimeGoals', 'scenarios'].some(key => companion[key]?.length > 0)
  db.setPreference('onboarding-completed', used)
  return { completed: used }
}
