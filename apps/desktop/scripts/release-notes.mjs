/**
 * What a tester build's release says (ADR 0127): encode-update.json, which the updater in the app reads, and the notes
 * on the release's page. Pure functions over what scripts/release-manifest.mjs reads in CI.
 */
import { createHash } from 'node:crypto'

/** Separators of `git log --format=%H%x1f%s%x1f%b%x1e`: between fields, and after each commit. */
export const LOG_FORMAT = '%H%x1f%s%x1f%b%x1e'

/**
 * One line for each change since the last release, newest first, from `git log --first-parent` on main: a pull
 * request's merge by its title and number, any other commit by its subject. At most twenty, as the app shows them.
 */
export function notesFromLog(log) {
  const notes = []
  for (const record of log.split('\x1e')) {
    const [hash, subject = '', body = ''] = record.replace(/^\s+/, '').split('\x1f')
    if (!hash?.trim()) continue
    // GitHub's own merge names the branch and puts the title in the body; a merge titled by hand has it after a colon.
    const merged = /^Merge pull request #(\d+)(?: from \S+$|: (.+))/.exec(subject)
    if (merged) {
      const title =
        merged[2]?.trim() ||
        body
          .split('\n')
          .map((line) => line.trim())
          .find(Boolean)
      if (title) notes.push(`${title} (#${merged[1]})`)
    } else if (!/^Merge (branch|remote-tracking branch) /.test(subject)) {
      notes.push(subject)
    }
  }
  return notes
    .map((line) => line.replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean)
    .map((line) => line[0].toUpperCase() + line.slice(1))
    .slice(0, 20)
}

/** A file of the release as the description names it: its name, size and SHA-256. */
export function releaseFile(name, bytes) {
  return { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** encode-update.json; services/updates.ts parseManifest reads it. */
export function manifestOf({ version, build, commit, publishedAt, notes, installer, portable }) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a commit: ${commit}`)
  if (!Number.isSafeInteger(build) || build < 1) throw new Error(`not a build number: ${build}`)
  return { schema: 1, channel: 'tester', version, build, commit, publishedAt, notes, installer, ...(portable ? { portable } : {}) }
}

/** The text of the release's page: what is new, how to install it, and each file's fingerprint. */
export function releaseBody(manifest) {
  const lines = [`Tester build ${manifest.build} of eNCode ${manifest.version}, from commit ${manifest.commit.slice(0, 7)}.`, '']
  if (manifest.notes.length) lines.push('What is new:', ...manifest.notes.map((note) => `- ${note}`), '')
  lines.push(
    `Install it with ${manifest.installer.name}. An installed tester build looks for the next one by itself, downloads it, checks its SHA-256 below, and installs it when you choose Restart to update. The eight tester builds handed out before this updater are updated by hand, once.`,
    '',
    'SHA-256:',
    `- ${manifest.installer.name}: ${manifest.installer.sha256}`,
  )
  if (manifest.portable) lines.push(`- ${manifest.portable.name}: ${manifest.portable.sha256}`)
  return `${lines.join('\n')}\n`
}

/** The newest release before `build`, from the repository's `build-<n>` tags; null when there is none. */
export function previousTag(tags, build) {
  let best = null
  for (const tag of tags) {
    const match = /^build-(\d+)$/.exec(tag.trim())
    const number = match ? Number(match[1]) : NaN
    if (Number.isSafeInteger(number) && number < build && (best === null || number > best)) best = number
  }
  return best === null ? null : `build-${best}`
}
