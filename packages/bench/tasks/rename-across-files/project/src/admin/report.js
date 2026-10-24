import { getUserNameLegacy } from '../legacy.js'
import * as users from '../users.js'

/** One line per user: the name people see, then the name the old system exports. */
export function userReport(list) {
  return list.map((user) => `${users.getUserName(user)} (${getUserNameLegacy(user)})`).join('\n')
}
