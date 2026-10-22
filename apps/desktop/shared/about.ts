import type { AboutInfo } from './types'

/** The first seven characters of a commit, which name it well enough for a person. */
export const shortCommit = (commit: string): string => commit.slice(0, 7)

/** The line a bug report starts with: "eNCode 0.1.0 tester, commit 502645e (built 2026-10-22T06:12:00.000Z)". */
export function buildLine(info: AboutInfo): string {
  const commit = info.commit ? `commit ${shortCommit(info.commit)}${info.dirty ? ' + local changes' : ''}` : 'no commit recorded'
  return `eNCode ${info.version} ${info.channel}, ${commit}${info.builtAt ? ` (built ${info.builtAt})` : ''}`
}

/** What "Copy build information" puts on the clipboard: the build line and what it runs on. */
export function aboutText(info: AboutInfo): string {
  return `${buildLine(info)}\n${info.os} ${info.arch}, Electron ${info.electron}, Chromium ${info.chrome}, Node ${info.node}`
}
