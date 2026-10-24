import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { addedLines, scanChanges, scanReminder, type ChangedText } from './diff-scan'

const added = (path: string, after: string, before: string | null = null): ChangedText => ({ path, before, after })
const rules = (files: ChangedText[]) => scanChanges(files).map((item) => `${item.rule} ${item.file}:${item.line}`)

describe('the lines a request added', () => {
  it('are the new lines with their numbers now, not those that were there', () => {
    assert.deepEqual(addedLines('a\nb\nc\n', 'a\nB\nb\nc\nd\n'), [
      { line: 2, text: 'B' },
      { line: 5, text: 'd' },
    ])
    assert.deepEqual(addedLines(null, 'x\r\ny'), [
      { line: 1, text: 'x' },
      { line: 2, text: 'y' },
    ])
  })
})

describe('the scan of added lines', () => {
  it('finds a credential written into code, and says so without repeating it', () => {
    const key = ['sk', 'or', 'v1', 'f3a9c1d27b6e48a0b5c9d3e1f7a2b4c6d8e0f1a3b5c7d9e2'].join('-')
    const found = scanChanges([added('src/config.ts', `export const client = new Client({ apiKey: '${key}' })\n`)])
    assert.deepEqual(found.map((item) => item.rule), ['secret'])
    assert.ok(!found[0].code.includes(key.slice(10)), 'the key is not shown again')
    assert.match(found[0].message, /an API key into the code/)
    assert.deepEqual(rules([added('src/db.py', 'DB_PASSWORD = "Q7v!r2Lk9mZp4tX"\n')]), ['secret src/db.py:1'])
    assert.deepEqual(rules([added('deploy/id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n')]), ['secret deploy/id_rsa:1'])
  })

  it('leaves out examples, placeholders, the environment, test values and .env files', () => {
    assert.deepEqual(
      rules([
        added('src/a.ts', "const apiKey = process.env.OPENROUTER_API_KEY\nconst token = 'your-token-here-please'\nconst password = '********'\n"),
        added('src/b.py', 'API_KEY = "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"\n'),
        added('test/auth.test.ts', "const password = 'Zq8LmN3vP0rT'\n"),
        added('.env', 'OPENAI_API_KEY=sk-proj-9f3a1c7e5b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a\n'),
      ]),
      [],
    )
  })

  it('finds SQL and command lines built from values, and not the parameterized forms', () => {
    assert.deepEqual(
      rules([
        added('src/users.ts', 'const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`)\nconst more = await db.query("SELECT * FROM users WHERE name = \'" + name + "\'")\n'),
        added('app/repo.py', 'cursor.execute(f"DELETE FROM orders WHERE id = {order_id}")\n'),
        added('server/bank.lua', "MySQL.query('UPDATE users SET money = ' .. amount .. ' WHERE identifier = ?', { id })\n"),
        added('store/store.go', 'rows, err := db.Query("SELECT name FROM items WHERE id = " + id)\n'),
        added('scripts/release.js', 'execSync(`git tag ${version}`)\n'),
        added('server/admin.lua', "ExecuteCommand('kick ' .. target)\n"),
      ]),
      ['sql src/users.ts:1', 'sql src/users.ts:2', 'sql app/repo.py:1', 'sql server/bank.lua:1', 'sql store/store.go:1', 'command scripts/release.js:1', 'command server/admin.lua:1'],
    )
    assert.deepEqual(
      rules([
        added('src/users.ts', 'const rows = await db.query(sql`SELECT * FROM users WHERE id = ${id}`)\nawait db.query(\'SELECT * FROM users WHERE id = $1\', [id])\nconst value = cache.get(key + suffix)\n'),
        added('server/bank.lua', "MySQL.update.await('UPDATE users SET money = ? WHERE identifier = ?', { amount, id })\nexports.ox_lib:notify({ description = 'Moved ' .. n .. ' items into the trunk' })\nExecuteCommand('refresh')\n"),
        added('app/repo.py', 'cursor.execute("SELECT * FROM t WHERE id = %s", (item_id,))\n'),
      ]),
      [],
    )
  })

  it('finds eval of a value, HTML set from a value, and TLS checks turned off', () => {
    assert.deepEqual(
      rules([
        added('html/app.js', "list.innerHTML = rows.map((row) => `<li>${row.name}</li>`).join('')\nconst result = eval(input)\nlist.innerHTML = ''\n"),
        added('src/Card.tsx', '<div dangerouslySetInnerHTML={{ __html: message.body }} />\n'),
        added('src/http.ts', 'const agent = new https.Agent({ rejectUnauthorized: false })\n'),
        added('fetch.py', 'requests.get(url, verify=False)\n'),
        added('server/main.lua', 'local fn = load(code)\n'),
      ]),
      ['html html/app.js:1', 'eval html/app.js:2', 'html src/Card.tsx:1', 'tls src/http.ts:1', 'tls fetch.py:1', 'eval server/main.lua:1'],
    )
    assert.deepEqual(rules([added('html/app.js', "el.textContent = name\nel.innerHTML = '<b>Ready</b>'\nconst n = ast.literal_eval\n")]), [])
  })

  it('only reads what the request added', () => {
    const before = "const rows = await db.query(`SELECT * FROM users WHERE id = ${id}`)\n"
    assert.deepEqual(rules([added('src/users.ts', `${before}const count = rows.length\n`, before)]), [])
  })
})

describe('the FiveM rules', () => {
  const server = (body: string) => added('resources/bank/server/main.lua', body)

  it('find a payout from a value the client sent, unchecked', () => {
    const found = scanChanges([
      server(
        [
          "RegisterNetEvent('bank:deposit', function(amount)",
          '  local xPlayer = ESX.GetPlayerFromId(source)',
          "  xPlayer.addAccountMoney('bank', amount)",
          'end)',
          '',
        ].join('\n'),
      ),
    ])
    assert.deepEqual(found.map((item) => `${item.rule}:${item.line}`), ['fivem-client-value:3'])
    assert.match(found[0].message, /takes `amount` from the client's `bank:deposit` event, and nothing checks it/)
  })

  it('pass a value the server checks or looks up, and handlers the request did not touch', () => {
    const checked = [
      "RegisterNetEvent('shop:buy', function(item, count)",
      '  local xPlayer = ESX.GetPlayerFromId(source)',
      '  local entry = Config.Items[item]',
      '  if not entry or count < 1 or count > 10 then return end',
      '  xPlayer.removeMoney(entry.price * count)',
      '  xPlayer.addInventoryItem(item, count)',
      'end)',
      '',
    ].join('\n')
    assert.deepEqual(rules([server(checked)]), [])
    const old = "RegisterNetEvent('bank:deposit', function(amount)\n  xPlayer.addMoney(amount)\nend)\n"
    assert.deepEqual(rules([server(`${old}\nprint('loaded')\n`)].map((file) => ({ ...file, before: old }))), [], 'the old handler is not the request’s')
  })

  it('find an action on a player the client names, unless the caller is checked', () => {
    const give = [
      "lib.callback.register('police:fine', function(source, target, fine)",
      '  local player = exports.qbx_core:GetPlayer(target)',
      "  player.Functions.RemoveMoney('bank', fine)",
      'end)',
      '',
    ].join('\n')
    assert.deepEqual(rules([server(give)]), ['fivem-client-target resources/bank/server/main.lua:2', 'fivem-client-value resources/bank/server/main.lua:3'])
    const admin = give.replace("  local player", "  if not IsPlayerAceAllowed(source, 'police.fine') then return end\n  if fine > Config.MaxFine then return end\n  local player")
    assert.deepEqual(rules([server(admin)]), [])
  })

  it('reads old-style handlers, JavaScript ones, and a client that sends a price', () => {
    const old = "RegisterServerEvent('jobs:pay')\nAddEventHandler('jobs:pay', function(reward)\n  xPlayer.addMoney(reward)\nend)\n"
    assert.deepEqual(rules([server(old)]), ['fivem-client-value resources/bank/server/main.lua:3'])
    const js = "onNet('jobs:pay', (reward) => {\n  const player = exports.qbx_core.GetPlayer(source)\n  player.Functions.AddMoney('cash', reward)\n})\n"
    assert.deepEqual(rules([added('resources/jobs/server/pay.js', js)]), ['fivem-client-value resources/jobs/server/pay.js:3'])
    assert.deepEqual(rules([added('resources/shop/client/main.lua', "TriggerServerEvent('shop:buy', item, price)\nTriggerServerEvent('shop:buy', item, count)\n")]), ['fivem-client-price resources/shop/client/main.lua:1'])
  })

  it('tells the agent to fix each or say why it is safe', () => {
    const text = scanReminder(scanChanges([server("RegisterNetEvent('a:b', function(n)\n  xPlayer.addMoney(n)\nend)\n")]))
    assert.match(text, /^eNCode's scan of the lines your changes added found what is often a security bug:\n- `resources\/bank\/server\/main\.lua:2` `xPlayer\.addMoney\(n\)`: /)
    assert.match(text, /Fix each, or say in your reply why it is safe here\.$/)
  })
})

describe('the scan on hostile input', () => {
  it('reads long, repetitive lines in linear time', () => {
    const shapes = ['a'.repeat(1_999), "'".repeat(1_999), '.'.repeat(1_999), 'select '.repeat(285), `db.query(\`${'${x}'.repeat(400)}`, `MySQL.query(${'a.'.repeat(999)}`, `password = '${'x_'.repeat(990)}'`, `${'_'.repeat(1_000)}api_key`, `RegisterNetEvent('a', function(${'b,'.repeat(990)})`]
    const started = performance.now()
    for (const shape of shapes) scanChanges([added('server/x.lua', `${shape}\n`.repeat(50)), added('src/x.ts', `${shape}\n`.repeat(50)), added('x.py', `${shape}\n`.repeat(50))])
    assert.ok(performance.now() - started < 2_000, `took ${Math.round(performance.now() - started)} ms`)
  })
})
