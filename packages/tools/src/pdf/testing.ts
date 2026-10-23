/**
 * A small PDF writer for tests, so each case says in a few lines what a file holds.
 */
export type Body = string | { dict: string; data: Uint8Array | string }

export const latin1 = (text: string) => Buffer.from(text, 'latin1')

/** Objects 1..n as given; the catalog must be object 1. `shift` moves every offset the table gives (a damaged file). */
export function build(objects: Body[], options: { shift?: number; noTable?: boolean; trailer?: string } = {}): Uint8Array {
  const parts: Buffer[] = [latin1('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')]
  let length = parts[0].length
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(length)
    const pieces: Buffer[] = []
    if (typeof object === 'string') pieces.push(latin1(`${index + 1} 0 obj\n${object}\nendobj\n`))
    else {
      const data = typeof object.data === 'string' ? latin1(object.data) : Buffer.from(object.data)
      pieces.push(latin1(`${index + 1} 0 obj\n<<${object.dict} /Length ${data.length}>>\nstream\n`), data, latin1('\nendstream\nendobj\n'))
    }
    for (const piece of pieces) {
      parts.push(piece)
      length += piece.length
    }
  })
  const trailer = options.trailer ?? `<< /Size ${objects.length + 1} /Root 1 0 R >>`
  if (options.noTable) parts.push(latin1(`trailer\n${trailer}\n%%EOF\n`))
  else {
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets) table += `${String(offset + (options.shift ?? 0)).padStart(10, '0')} 00000 n \n`
    parts.push(latin1(`${table}trailer\n${trailer}\nstartxref\n${length}\n%%EOF\n`))
  }
  return new Uint8Array(Buffer.concat(parts))
}

export const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

/** One page per content string, all with Helvetica as /F1 (object 3) and `resources` added. */
export function pages(contents: string[], options: { resources?: string; extra?: Body[]; page?: string } = {}): Uint8Array {
  const first = 4 + (options.extra?.length ?? 0)
  const kids = contents.map((_, index) => `${first + index * 2} 0 R`).join(' ')
  const objects: Body[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`, HELVETICA, ...(options.extra ?? [])]
  contents.forEach((content, index) => {
    const self = first + index * 2
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${options.resources ?? ''} >> /Contents ${self + 1} 0 R ${options.page ?? ''} >>`)
    objects.push({ dict: '', data: content })
  })
  return build(objects)
}

export const line = (text: string, x = 72, y = 700, size = 12) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET\n`
