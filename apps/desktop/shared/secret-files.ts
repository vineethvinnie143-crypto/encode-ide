/**
 * Files that are a secret or hold them, by name: their text is never sent for a suggestion (ADR 0087), and a report
 * of an editor issue in one carries its words replaced (ADR 0088). A sample of one (`.env.example`) holds none. Pure,
 * so the page and the main process judge alike.
 */
const SECRET_NAMES = new Set(['.env', '.npmrc', '.pypirc', '.netrc', '_netrc', '.git-credentials', 'credentials', 'credentials.json', 'secrets.json', 'secrets.yml', 'secrets.yaml', '.htpasswd', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'])
const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.kdbx', '.tfvars'])
const SAMPLE = /\.(?:example|sample|template|dist)$/i

/** Whether a file, by its path in the folder, is one that holds secrets. */
export function isSecretFile(relative: string): boolean {
  const parts = relative.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = (parts[parts.length - 1] ?? '').toLowerCase()
  if (SAMPLE.test(name)) return false
  if (SECRET_NAMES.has(name) || name.startsWith('.env.')) return true
  const dot = name.lastIndexOf('.')
  return dot > 0 && SECRET_EXTENSIONS.has(name.slice(dot))
}
