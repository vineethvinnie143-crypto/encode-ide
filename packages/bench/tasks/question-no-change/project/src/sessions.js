import { SESSION_TIMEOUT_MINUTES } from '../config/session.js'

const sessions = new Map()

export function touch(id, now = Date.now()) {
  sessions.set(id, now + SESSION_TIMEOUT_MINUTES * 60_000)
}

export function isActive(id, now = Date.now()) {
  return (sessions.get(id) ?? 0) > now
}
