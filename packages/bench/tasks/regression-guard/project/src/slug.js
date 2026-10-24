/** A URL path for a title. A title may name folders with /, as in docs/Getting Started. */
export function slug(title) {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
}
