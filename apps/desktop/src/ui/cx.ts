/** Joins class names, skipping false, null, undefined and empty strings. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}
