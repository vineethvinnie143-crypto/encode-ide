import { getUserName } from './users.js'

export function greeting(user) {
  return `Hello ${getUserName(user)},`
}
