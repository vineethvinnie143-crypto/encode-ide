/** The command line's version: the app's, as both are built from one commit. cli.test.ts keeps it in step. */
export const VERSION = '0.1.0'

/** What the app's build stamps into every bundle (apps/desktop/scripts/main-build.mjs); absent when run from source. */
declare const __ENCODE_BUILD__: { commit?: string; dirty?: boolean; channel?: string } | undefined

/** `eNCode 0.1.0`, then the build's channel and commit when it has them, as the app's About box says it. */
export function versionLine(build = typeof __ENCODE_BUILD__ === 'undefined' ? undefined : __ENCODE_BUILD__): string {
  const commit = /^[0-9a-f]{40}$/.test(build?.commit ?? '') ? build!.commit!.slice(0, 7) : ''
  const channel = build?.channel && /^[a-z]+$/.test(build.channel) ? ` ${build.channel}` : ''
  return `eNCode ${VERSION}${commit ? `${channel}, commit ${commit}${build?.dirty ? ' + local changes' : ''}` : ''}`
}
