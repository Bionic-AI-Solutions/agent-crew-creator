/**
 * Decide whether an edit form should (re)seed its local state from freshly
 * loaded server data. Only reseed when the entity IDENTITY changes — i.e. on
 * first load or when switching to a different record — never on a background
 * refetch of the same record, which would clobber the user's unsaved edits.
 *
 * (Finding #10: AgentConfigForm reseeded on every getById data change, so any
 * sibling panel invalidating that query wiped in-progress typing.)
 */
export function shouldReseedForm(
  seededId: number | null,
  entityId: number | undefined | null,
): boolean {
  return entityId != null && seededId !== entityId;
}
