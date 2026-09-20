/** Restore withdrawn wording without discarding or duplicating the current draft. */
export function restoreWithdrawnDraft(draft: string, original: string) {
  if (!draft.trim()) return original
  if (draft.trim() === original.trim()) return draft
  return draft + '\n\n' + original
}
