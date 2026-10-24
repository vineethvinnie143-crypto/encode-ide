/** The name as the old accounts system kept it: last name first. Still used by the export to that system. */
export function getUserNameLegacy(user) {
  return [user.lastName, user.firstName].filter(Boolean).join(', ')
}
