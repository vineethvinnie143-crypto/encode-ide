/**
 * Shows which free models eNCode's router would use, with every price
 * OpenRouter lists for each, and checks that none of them costs anything.
 *
 *   node scripts/free-models.mjs                     the picks, from OpenRouter's public model list (no key needed)
 *   node scripts/free-models.mjs --file models.json  the same from a saved copy of /api/v1/models, offline
 *   OPENROUTER_API_KEY=... node scripts/free-models.mjs --test 3
 *       also makes 3 real calls through the router in free-only mode, then compares the
 *       key's credit usage and free-request count from before and after. Models the account
 *       cannot use (its privacy settings exclude them, or OpenRouter limits them to listed apps)
 *       are skipped and reported, and the calls go on down the list until 3 answer.
 *
 * Options: --role <role> (default main), --limit <n> picks to list (default 10), --test <n> real calls (default 0),
 *          --wait <seconds> for the key's usage figures to settle after the calls (default 4)
 * Behind a proxy (HTTPS_PROXY set), run with NODE_USE_ENV_PROXY=1: Node's fetch ignores the proxy otherwise.
 *
 * The key is read from the environment only, goes to openrouter.ai and nowhere
 * else, and is never printed. Exit status: 0 when every check holds, 1 when one
 * fails, 2 when the script could not run.
 */
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://openrouter.ai/api/v1'

async function usage() {
  const source = await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
  console.log(source.slice(source.indexOf('/**') + 3, source.indexOf('*/')).replace(/^ \* ?/gm, '').trim())
}

function parseArgs(argv) {
  const options = { role: 'main', limit: 10, test: 0, wait: 4, file: undefined }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    const value = () => {
      const next = argv[++index]
      if (next === undefined) throw new Error(`${name} needs a value`)
      return next
    }
    if (name === '--help' || name === '-h') options.help = true
    else if (name === '--file') options.file = value()
    else if (name === '--role') options.role = value()
    else if (name === '--limit') options.limit = Number.parseInt(value(), 10)
    else if (name === '--test') options.test = Number.parseInt(value(), 10)
    else if (name === '--wait') options.wait = Number(value())
    else throw new Error(`unknown option ${name}`)
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || !Number.isInteger(options.test) || options.test < 0 || options.test > 20) {
    throw new Error('--limit must be a positive number and --test a number from 0 to 20')
  }
  if (!Number.isFinite(options.wait) || options.wait < 0 || options.wait > 600) throw new Error('--wait must be a number of seconds from 0 to 600')
  return options
}

/** The router, bundled from source the way the tests are, so this runs on a fresh checkout. */
async function loadRouter() {
  const bundle = await build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/index'\nexport { createOpenRouterAdapter } from '@encode/providers'\n",
      resolveDir: path.join(root, 'packages', 'router'),
      sourcefile: 'free-models-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const cell = (value, width) => String(value).padEnd(width)

/** One line saying what a model costs: every price is zero, or which ones are not. */
function priceSummary(pricing) {
  const fields = Object.entries(pricing)
  const charged = fields.filter(([name, value]) => name !== 'discount' && !(String(value).trim() !== '' && Number(value) === 0))
  if (charged.length) return `CHARGES: ${charged.map(([name, value]) => `${name} ${value}`).join(', ')}`
  return `all ${fields.length} prices are 0 (${fields.map(([name]) => name).join(', ')})`
}

/** fetch, with a failure that says where it could not get to. */
async function get(url, headers) {
  try {
    return await fetch(url, { headers: { accept: 'application/json', ...headers } })
  } catch (error) {
    // Node's own fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set.
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy
    const hint = !proxy
      ? ''
      : process.env.NODE_USE_ENV_PROXY
        ? ' (this machine reaches the internet through a proxy, which may not allow this host)'
        : ' (this machine reaches the internet through a proxy: run with NODE_USE_ENV_PROXY=1)'
    throw new Error(`could not reach ${new URL(url).host}: ${error?.cause?.message ?? error?.message ?? error}${hint}`)
  }
}

async function loadCatalog(file) {
  if (file) return JSON.parse(await fs.readFile(path.resolve(file), 'utf8'))
  const response = await get(`${BASE}/models`)
  if (!response.ok) throw new Error(`OpenRouter's model list answered HTTP ${response.status}`)
  return response.json()
}

/** The key's own numbers: credits used and left, and how many free requests it has made today. */
async function keyInfo(key) {
  const response = await get(`${BASE}/key`, { authorization: `Bearer ${key}` })
  if (!response.ok) throw new Error(`GET /key answered HTTP ${response.status}`)
  const data = (await response.json())?.data
  return data && typeof data === 'object' ? data : {}
}

const creditFields = (data) => Object.entries(data).filter(([name, value]) => typeof value === 'number' && /usage|limit_remaining/.test(name))

function printReport(report, options) {
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`
  console.log(`OpenRouter lists ${plural(report.listed, 'model', 'models')}; ${report.free} ${report.free === 1 ? 'is' : 'are'} free (an id ending in :free, with every price at zero).`)
  console.log(`@free would try these first for the ${options.role} role (a listing only makes a model a candidate; --test shows which ones answer):\n`)
  const width = Math.max(5, ...report.picks.map((pick) => pick.model.length))
  for (const pick of report.picks) {
    console.log(`${cell(pick.rank, 3)} ${cell(pick.model, width)}  ${cell(pick.contextWindow.toLocaleString('en-US'), 9)} ${cell(pick.tools ? 'tools' : 'no tools', 9)} ${priceSummary(pick.pricing)}`)
  }
  if (!report.picks.length) console.log('(none)')
  if (report.notInPool.length) {
    console.log(`\nFree, but not in the pool (${report.notInPool.length}):`)
    for (const entry of report.notInPool.slice(0, 15)) console.log(`  ${entry.model}: ${entry.reason}`)
    if (report.notInPool.length > 15) console.log(`  … and ${report.notInPool.length - 15} more`)
  }
  if (report.leftOut.length) {
    console.log(`\nLeft out because they are not provably free (${report.leftOut.length}):`)
    for (const entry of report.leftOut.slice(0, 15)) console.log(`  ${entry.model}: ${entry.reasons.join('; ')}`)
    if (report.leftOut.length > 15) console.log(`  … and ${report.leftOut.length - 15} more`)
  }
}

async function liveCheck(mod, key, catalog, report, options) {
  const secrets = [key]
  const clean = (text) => mod.redact(String(text), secrets)
  const before = await keyInfo(key)
  const alerts = []
  const router = mod.createRouter({
    config: mod.parseRouterConfig({ freeOnly: true }).config,
    adapters: [mod.createOpenRouterAdapter()],
    keys: mod.staticKeys({ openrouter: key }),
    onAlert: (alert) => alerts.push(alert),
  })
  router.registry.setCatalog('openrouter', mod.parseOpenRouterCatalog(catalog), Date.now())

  console.log(`\nMaking ${options.test} real call${options.test === 1 ? '' : 's'}, in free-only mode:`)
  let answered = 0
  let tried = 0
  let shutOut = 0
  const costs = []
  for (const pick of report.picks) {
    if (answered >= options.test || tried >= options.test + 3) break
    const result = await router.checkModel(`openrouter:${pick.model}`)
    if (result.blocked) {
      // Shut out of this model by the account or the app: nothing against its price, and the router skips it from now on.
      shutOut++
      console.log(`  – ${pick.model}: skipped. ${clean(result.message)}`)
      continue
    }
    tried++
    if (!result.ok) {
      console.log(`  ✖ ${pick.model}: ${clean(result.message)}`)
      continue
    }
    answered++
    if (result.cost !== undefined) costs.push(result.cost)
    const cost = result.cost === undefined ? 'cost not reported' : `cost $${result.cost}`
    const seconds = result.ttftMs === undefined ? '' : `, first token after ${(result.ttftMs / 1000).toFixed(1)} s`
    console.log(`  ✔ ${pick.model}: answered${seconds}, ${result.toolCall ? 'called the tool' : 'did not call the tool'}, ${cost}`)
  }

  console.log(`  ${answered} answered${shutOut ? `, ${shutOut} shut out by this account or app (the router skips those for a day)` : ''}${tried - answered ? `, ${tried - answered} failed` : ''}.`)

  await sleep(options.wait * 1_000)
  const after = await keyInfo(key)
  const problems = []
  console.log('\nThe key before and after:')
  const names = [...new Set([...creditFields(before), ...creditFields(after)].map(([name]) => name))]
  for (const name of names) {
    const same = before[name] === after[name]
    console.log(`  ${same ? '✔' : '✖'} ${cell(name, 18)} ${before[name]} → ${after[name]}${same ? '' : '   CHANGED'}`)
    if (!same) problems.push(`${name} changed from ${before[name]} to ${after[name]}: something may have been charged.`)
  }
  if (!names.length) console.log('  (the key response has no credit figures to compare; the per-call costs above are the only evidence)')
  const free = (data) => data.free_model_daily_requests
  if (free(before) && free(after)) {
    const moved = free(before).used !== free(after).used
    console.log(`  free requests used today: ${free(before).used} → ${free(after).used} of ${free(after).limit}${moved ? '' : " (OpenRouter's count runs late, so this proves nothing either way)"}`)
  }

  // A model the account is shut out of is reported above; every other alert (a bill, a refused key, an empty list) is a problem.
  for (const alert of alerts) if (alert.type !== 'model-refused') problems.push(clean(alert.message))
  if (costs.some((cost) => cost > 0)) problems.push('a call reported a cost above zero.')
  if (!answered) problems.push('no call was answered, so the comparison above proves nothing; try again.')
  return problems
}

/** Runs the script and returns its exit status. */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`free-models: ${error.message}\n`)
    await usage()
    return 2
  }
  if (options.help) {
    await usage()
    return 0
  }
  const key = process.env.OPENROUTER_API_KEY?.trim()
  if (options.test > 0 && !key) {
    console.error('free-models: --test makes real calls, so it needs your key in the OPENROUTER_API_KEY environment variable.')
    return 2
  }

  const mod = await loadRouter()
  const catalog = await loadCatalog(options.file)
  const report = mod.freeReport(catalog, { role: options.role, limit: options.limit })
  printReport(report, options)
  const problems = [...report.problems]
  if (options.test > 0) problems.push(...(await liveCheck(mod, key, catalog, report, options)))

  console.log()
  if (problems.length) {
    console.log('NOT CLEAN:')
    for (const problem of problems) console.log(`  ✖ ${problem}`)
    return 1
  }
  console.log(options.test > 0 ? 'Clean: every pick is free by its listing, and the key was not charged.' : 'Clean: every pick is free by its listing.')
  return 0
}

main().then(
  (status) => {
    process.exitCode = status
  },
  (error) => {
    const key = process.env.OPENROUTER_API_KEY?.trim()
    const text = error instanceof Error ? error.message : String(error)
    console.error(`free-models: ${key ? text.split(key).join('[redacted]') : text}`)
    process.exitCode = 2
  },
)
