/** The helper's C# sources and manifest are embedded as text by the bundler (esbuild's `text` loader). */
declare module '*.cs' {
  const text: string
  export default text
}

declare module '*.manifest' {
  const text: string
  export default text
}
