/** What people see as a user's name: the display name they chose, or their first and last name. */
export function getUserName(user) {
  if (user.displayName) return user.displayName
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown user'
}
