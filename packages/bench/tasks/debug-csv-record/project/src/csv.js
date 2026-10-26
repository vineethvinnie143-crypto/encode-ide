// Reads the sales export: a header line, then one record a line.

export function parseLine(line) {
  return line.split(',')
}

export function readCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const header = parseLine(lines[0])
  return lines.slice(1).map((line) => {
    const fields = parseLine(line)
    const record = {}
    header.forEach((name, index) => {
      record[name] = fields[index]
    })
    return record
  })
}
