/**
 * A node:test reporter that keeps only what failed, a few lines each, with no stack traces. scripts/test.mjs adds it
 * when ENCODE_TEST_DIGEST names a file, so the end of a long CI log can say what went wrong in a screenful.
 */
const LINES_PER_FAILURE = 6
const WIDTH = 240

function messageOf(error) {
  const cause = error?.code === 'ERR_TEST_FAILURE' && error.cause ? error.cause : error
  const text = String(cause?.message ?? cause ?? 'failed')
  const code = typeof cause?.code === 'string' && cause.code !== 'ERR_TEST_FAILURE' ? ` [${cause.code}]` : ''
  const lines = text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(0, LINES_PER_FAILURE)
    .map((line) => (line.length > WIDTH ? `${line.slice(0, WIDTH)}...` : line))
  return `${lines.join('\n    ')}${code}`
}

export default async function* digest(source) {
  let passed = 0
  let skipped = 0
  const failures = []
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue
    if (event.data.details?.type === 'suite') continue
    if (event.type === 'test:pass') {
      if (event.data.skip || event.data.todo) skipped += 1
      else passed += 1
    } else {
      failures.push(`FAIL ${event.data.name}\n    ${messageOf(event.data.details?.error)}\n    at ${event.data.file ?? '?'}:${event.data.line ?? '?'}`)
    }
  }
  yield `${passed} passed, ${failures.length} failed, ${skipped} skipped\n`
  for (const failure of failures) yield `${failure}\n`
}
