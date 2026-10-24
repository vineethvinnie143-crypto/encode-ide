import { getUserName } from './users.js'

export function profileHeading(user) {
  return `Profile of ${getUserName(user)}`
}
