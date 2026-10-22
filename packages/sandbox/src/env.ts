/** Variables are matched without regard to case on Windows, where `Temp` and `TEMP` are one variable. */
export function mergeEnv(base: Record<string, string>, extra: Readonly<Record<string, string>>, unset: readonly string[], platform: NodeJS.Platform): Record<string, string> {
  const fold = (name: string) => (platform === 'win32' ? name.toUpperCase() : name)
  const replaced = new Set([...Object.keys(extra), ...unset].map(fold))
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (!replaced.has(fold(name))) out[name] = value
  return { ...out, ...extra }
}
