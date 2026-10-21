import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { expandSetup, loadMcpConfig, mcpConfigFiles, parseMcpFile, parseSetup, type ServerSetup } from './config'

const file = (servers: unknown) => JSON.stringify({ mcpServers: servers })

describe('MCP configuration files', () => {
  it('reads stdio, http and sse servers', () => {
    const { servers, problems } = parseMcpFile(
      file({
        files: { command: 'npx', args: ['-y', '@acme/files'], env: { TOKEN: '${ACME_TOKEN}' } },
        docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: { Authorization: 'Bearer ${DOCS_KEY}' } },
        inferred: { url: 'https://x.example.com/mcp' },
        alias: { type: 'streamable-http', url: 'https://y.example.com/mcp' },
        old: { type: 'sse', url: 'https://old.example.com/sse' },
        bare: { command: 'node' },
      }),
      'project',
      '/work/.mcp.json',
    )
    assert.deepEqual(problems, [])
    assert.deepEqual(servers.map((s) => [s.name, s.setup.type]), [['files', 'stdio'], ['docs', 'http'], ['inferred', 'http'], ['alias', 'http'], ['old', 'sse'], ['bare', 'stdio']])
    assert.deepEqual(servers[0].setup, { type: 'stdio', command: 'npx', args: ['-y', '@acme/files'], env: { TOKEN: '${ACME_TOKEN}' } })
    assert.deepEqual(servers[0].variables, ['ACME_TOKEN'])
    assert.deepEqual(servers[1].variables, ['DOCS_KEY'])
    assert.deepEqual(servers[5].setup, { type: 'stdio', command: 'node', args: [], env: {} })
    assert.ok(servers.every((s) => s.scope === 'project' && s.file === '/work/.mcp.json'))
  })

  it('digests the setup as written, so only a real change asks for approval again', () => {
    const digest = (json: string) => parseMcpFile(json, 'project', 'f').servers[0].digest
    const base = digest('{"mcpServers":{"a":{"command":"x","args":["1"],"env":{"A":"1","B":"2"}}}}')
    assert.equal(digest('{ "mcpServers": { "a": { "env": { "B": "2", "A": "1" }, "args": ["1"], "command": "x", "type": "stdio" } } }'), base)
    assert.notEqual(digest('{"mcpServers":{"a":{"command":"x","args":["2"],"env":{"A":"1","B":"2"}}}}'), base)
    assert.notEqual(digest('{"mcpServers":{"a":{"command":"y","args":["1"],"env":{"A":"1","B":"2"}}}}'), base)
    assert.notEqual(digest('{"mcpServers":{"a":{"command":"x","args":["1"],"env":{"A":"1","B":"3"}}}}'), base)
    assert.notEqual(digest('{"mcpServers":{"b":{"command":"x","args":["1"],"env":{"A":"1","B":"2"}}}}'), base)
    // The file and the scope are not part of what is approved.
    assert.equal(parseMcpFile('{"mcpServers":{"a":{"command":"x","args":["1"],"env":{"A":"1","B":"2"}}}}', 'user', 'other').servers[0].digest, base)
  })

  it('leaves out a server it cannot use and says why, keeping the rest', () => {
    const { servers, problems } = parseMcpFile(
      file({
        good: { command: 'node' },
        'bad name': { command: 'node' },
        a__b: { command: 'node' },
        both: { command: 'node', url: 'https://x.example.com' },
        newline: { command: 'node\nrm -rf' },
        args: { command: 'node', args: 'one' },
        envname: { command: 'node', env: { 'BAD-NAME': 'x' } },
        proto: { command: 'node', env: JSON.parse('{"__proto__": "x"}') },
        ftp: { url: 'ftp://example.com/mcp' },
        creds: { url: 'https://user:pass@example.com/mcp' },
        reserved: { url: 'https://example.com/mcp', headers: { Host: 'evil.example' } },
        crlf: { url: 'https://example.com/mcp', headers: { 'X-A': 'a\r\nX-B: b' } },
        kind: { type: 'carrier-pigeon', command: 'node' },
        text: 'node',
        empty: {},
        mixed: { type: 'http', command: 'node' },
      }),
      'project',
      'f',
    )
    assert.deepEqual(servers.map((s) => s.name), ['good'])
    assert.equal(problems.length, 15, problems.join('\n'))
    assert.ok(problems.every((p) => p.startsWith('f: the server ')))
  })

  it('notes settings it does not use, and refuses files that are not configuration', () => {
    const noted = parseMcpFile(file({ a: { command: 'node', timeout: 5 } }), 'user', 'f')
    assert.equal(noted.servers.length, 1)
    assert.match(noted.problems[0], /"timeout" is not a setting eNCode uses/)
    for (const text of ['not json', '[]', '{}', '{"mcpServers": []}', 'x'.repeat(1024 * 1024 + 1)]) {
      const result = parseMcpFile(text, 'user', 'f')
      assert.deepEqual(result.servers, [])
      assert.equal(result.problems.length, 1)
    }
    assert.equal(parseMcpFile(`\uFEFF${file({ a: { command: 'node' } })}`, 'user', 'f').servers.length, 1)
    const many = parseMcpFile(file(Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`s${i}`, { command: 'node' }]))), 'user', 'f')
    assert.equal(many.servers.length, 100)
    assert.match(many.problems[0], /more than 100 servers/)
  })

  it('checks an address once its variables are filled in', () => {
    assert.equal(typeof parseSetup({ url: 'https://${HOST}/mcp' }), 'object')
    assert.equal(typeof parseSetup({ url: 'ws://example.com' }), 'string')
  })
})

describe('variables', () => {
  const stdio: ServerSetup = { type: 'stdio', command: '${BIN:-node}', args: ['--key=${KEY}', '${EMPTY:-fallback}', '${EMPTY}'], env: { A: '${HOME_DIR}/x' } }

  it('fills in variables the way a shell does', () => {
    const env = { KEY: 'k', EMPTY: '', HOME_DIR: '/home/u' }
    assert.deepEqual(expandSetup(stdio, env, false), { type: 'stdio', command: 'node', args: ['--key=k', 'fallback', ''], env: { A: '/home/u/x' } })
    assert.equal((expandSetup(stdio, { ...env, BIN: 'deno' }, false) as { command: string }).command, 'deno')
  })

  it('does not take $ in a value for something to expand, nor expand twice', () => {
    const result = expandSetup({ type: 'stdio', command: 'node', args: ['${A}'], env: {} }, { A: '${B} $& $1', B: 'no' }, false)
    assert.deepEqual((result as { args: string[] }).args, ['${B} $& $1'])
  })

  it('says which variables are missing, and does not start with a hole in the command', () => {
    assert.match(expandSetup(stdio, {}, false) as string, /environment variables EMPTY, HOME_DIR, KEY are not set/)
    assert.match(expandSetup({ type: 'http', url: 'https://x.example.com', headers: { A: '${TOKEN}' } }, {}, false) as string, /TOKEN is not set/)
  })

  it('compares names without case on Windows only', () => {
    const setup: ServerSetup = { type: 'stdio', command: 'node', args: ['${Path}'], env: {} }
    assert.deepEqual((expandSetup(setup, { PATH: 'C:\\bin' }, true) as { args: string[] }).args, ['C:\\bin'])
    assert.match(expandSetup(setup, { PATH: '/bin' }, false) as string, /Path is not set/)
  })

  it('checks the result: a command on one line, an address that is one, headers that are single lines', () => {
    assert.match(expandSetup({ type: 'stdio', command: '${C}', args: [], env: {} }, { C: 'node\nrm' }, false) as string, /not on one line/)
    assert.match(expandSetup({ type: 'stdio', command: '${C}', args: [], env: {} }, { C: ' ' }, false) as string, /empty/)
    assert.match(expandSetup({ type: 'http', url: '${U}', headers: {} }, { U: 'file:///etc/passwd' }, false) as string, /address/)
    assert.match(expandSetup({ type: 'http', url: 'https://x.example.com', headers: { A: '${V}' } }, { V: 'a\r\nHost: evil' }, false) as string, /headers/)
    assert.match(expandSetup({ type: 'stdio', command: 'node', args: ['${V}'], env: {} }, { V: 'a\u0000b' }, false) as string, /NUL/)
  })
})

describe('loading the three files', () => {
  const files: Record<string, string> = {}
  const read = async (name: string) => files[name] ?? null
  const setup = (...entries: Array<[string, string]>) => {
    for (const key of Object.keys(files)) delete files[key]
    for (const [name, text] of entries) files[name] = text
  }

  it('reads the user file, .mcp.json and .encode/mcp.json', async () => {
    setup(
      ['/home/u/.encode/mcp.json', file({ mine: { command: 'a' } })],
      ['/work/.mcp.json', file({ shared: { command: 'b' }, both: { command: 'old' } })],
      ['/work/.encode/mcp.json', file({ both: { command: 'new' }, only: { command: 'c' } })],
    )
    const { servers, problems } = await loadMcpConfig({ home: '/home/u', root: '/work', read, platform: 'linux' })
    assert.deepEqual(problems, [])
    assert.deepEqual(servers.map((s) => [s.name, s.scope, (s.setup as { command: string }).command]), [['mine', 'user', 'a'], ['shared', 'project', 'b'], ['both', 'project', 'new'], ['only', 'project', 'c']])
  })

  it('does not let a project replace a server the user set up', async () => {
    setup(['/home/u/.encode/mcp.json', file({ github: { command: 'mine' } })], ['/work/.mcp.json', file({ github: { command: 'steal-tokens' }, other: { command: 'x' } })])
    const { servers, problems } = await loadMcpConfig({ home: '/home/u', root: '/work', read, platform: 'linux' })
    assert.deepEqual(servers.map((s) => [s.name, s.scope, (s.setup as { command: string }).command]), [['github', 'user', 'mine'], ['other', 'project', 'x']])
    assert.equal(problems.length, 1)
    assert.match(problems[0], /"github" was ignored/)
  })

  it('reports a file it cannot read and carries on', async () => {
    const failing = async (name: string) => {
      if (name.endsWith('.mcp.json')) throw new Error('permission denied')
      return name.includes('.encode') && name.startsWith('/home') ? file({ a: { command: 'x' } }) : null
    }
    const { servers, problems } = await loadMcpConfig({ home: '/home/u', root: '/work', read: failing, platform: 'linux' })
    assert.equal(servers.length, 1)
    assert.match(problems[0], /could not be read: permission denied/)
  })

  it('follows the platform it is told about', async () => {
    assert.deepEqual(mcpConfigFiles('C:\\Users\\u', 'D:\\ws', (await import('node:path')).win32).map((f) => f.file), ['C:\\Users\\u\\.encode\\mcp.json', 'D:\\ws\\.mcp.json', 'D:\\ws\\.encode\\mcp.json'])
    setup(['C:\\Users\\u\\.encode\\mcp.json', file({ a: { command: 'x' } })])
    assert.equal((await loadMcpConfig({ home: 'C:\\Users\\u', root: 'D:\\ws', read, platform: 'win32' })).servers.length, 1)
  })
})
