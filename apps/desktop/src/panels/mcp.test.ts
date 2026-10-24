import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpReport, McpServerView } from '@shared/types'
import { approvalWarning, bannerKey, cardActions, environmentLine, mcpBannerOf, newServerOf, offerLine, parsePairs, splitCommandLine, summaryLine, waitingServers, writtenValues } from './mcp'

const server = (patch: Partial<McpServerView> = {}): McpServerView => ({
  name: 'github',
  scope: 'project',
  file: '/code/app/.mcp.json',
  state: 'connected',
  digest: 'a'.repeat(64),
  summary: 'npx -y @modelcontextprotocol/server-github',
  envNames: [],
  headerNames: [],
  variables: [],
  tools: [],
  resources: 0,
  prompts: 0,
  hasInstructions: false,
  problems: [],
  log: [],
  ...patch,
})

const report = (servers: McpServerView[], patch: Partial<McpReport> = {}): McpReport => ({
  root: '/code/app',
  trusted: true,
  broken: null,
  starting: false,
  servers,
  problems: [],
  files: { user: '/home/u/.encode/mcp.json', project: '/code/app/.mcp.json', encode: '/code/app/.encode/mcp.json' },
  ...patch,
})

const tool = (name: string) => ({ name, description: '' })

describe('what a server offers', () => {
  it('counts what there is and leaves out what there is not', () => {
    assert.equal(offerLine(server({ tools: [tool('a'), tool('b'), tool('c')], resources: 1, prompts: 2 })), '3 tools, 1 resource, 2 prompts')
    assert.equal(offerLine(server({ tools: [tool('a')], hasInstructions: true })), '1 tool, instructions for the agent')
    assert.equal(offerLine(server()), 'It offers nothing yet')
    assert.equal(offerLine(server({ state: 'failed' })), '')
  })
})

describe('the line above the list', () => {
  it('says how many servers are in each state that matters', () => {
    assert.equal(summaryLine(report([])), 'No servers set up')
    const states = [server({ state: 'connected' }), server({ name: 'b', state: 'connected' }), server({ name: 'c', state: 'needs-approval' }), server({ name: 'd', state: 'failed' }), server({ name: 'e', state: 'disabled' }), server({ name: 'f', state: 'stopped' })]
    assert.equal(summaryLine(report(states)), '2 running, 1 waiting for you, 1 failed, 2 not running')
    assert.equal(summaryLine(report([server({ state: 'connecting' })])), '1 starting')
  })
})

describe('what a server’s card offers', () => {
  const kinds = (view: McpServerView, folder: Pick<McpReport, 'trusted' | 'broken'> = { trusted: true, broken: null }) => cardActions(view, folder).map((action) => action.kind)

  it('offers approval for a project’s server that waits, once the folder is trusted', () => {
    assert.deepEqual(kinds(server({ state: 'needs-approval' })), ['approve', 'turn-off'])
    const blocked = cardActions(server({ state: 'needs-approval' }), { trusted: false, broken: null })[0]
    assert.equal(blocked.kind === 'approve' && blocked.blocked, 'Trust this folder first (Settings, Permissions).')
    const open = cardActions(server({ state: 'needs-approval' }), { trusted: true, broken: null })[0]
    assert.equal(open.kind === 'approve' && open.blocked, undefined)
  })

  it('offers a restart, turning off and taking back an approval for one that runs or failed', () => {
    for (const state of ['connected', 'failed', 'stopped'] as const) assert.deepEqual(kinds(server({ state })), ['restart', 'turn-off', 'forget'], state)
    assert.deepEqual(kinds(server({ state: 'connected', scope: 'user' })), ['restart', 'turn-off'], 'your own server has no approval to take back')
    assert.deepEqual(kinds(server({ state: 'connecting' })), ['turn-off'])
  })

  it('offers to turn a server on that is off, and nothing while the settings cannot be trusted', () => {
    assert.deepEqual(kinds(server({ state: 'disabled' })), ['turn-on'])
    assert.deepEqual(kinds(server({ state: 'connected' }), { trusted: true, broken: 'Fix the settings.' }), [])
  })
})

describe('the banner above the composer', () => {
  it('names the project’s servers that wait, and not the person’s own or those already decided', () => {
    assert.equal(mcpBannerOf(null), null)
    assert.equal(mcpBannerOf(report([server({ state: 'connected' }), server({ name: 'x', state: 'disabled' }), server({ name: 'mine', scope: 'user', state: 'needs-approval' })])), null)
    const one = mcpBannerOf(report([server({ state: 'needs-approval' })]))
    assert.equal(one?.text, 'This folder asks to run an MCP server (github). It starts only if you approve it.')
    assert.equal(one?.action, 'Review')
    const many = mcpBannerOf(report(['a', 'b', 'c', 'd', 'e'].map((name) => server({ name, state: 'needs-approval' }))))
    assert.equal(many?.text, 'This folder asks to run 5 MCP servers (a, b, c and 2 more). They start only if you approve them.')
  })

  it('stays quiet while the settings cannot be trusted', () => {
    assert.equal(mcpBannerOf(report([server({ state: 'needs-approval' })], { broken: 'Fix it.' })), null)
    assert.deepEqual(waitingServers(report([server({ state: 'needs-approval' })], { broken: 'Fix it.' })), [])
  })

  it('is dismissed for what waits now, and comes back when a server changes or another one arrives', () => {
    const before = bannerKey(report([server({ name: 'a', state: 'needs-approval' })]))
    assert.equal(bannerKey(report([server({ name: 'a', state: 'needs-approval' }), server({ name: 'ok', state: 'connected' })])), before, 'servers that run do not matter')
    assert.notEqual(bannerKey(report([server({ name: 'a', state: 'needs-approval', digest: 'b'.repeat(64) })])), before)
    assert.notEqual(bannerKey(report([server({ name: 'a', state: 'needs-approval' }), server({ name: 'b', state: 'needs-approval' })])), before)
    assert.notEqual(bannerKey(report([server({ name: 'a', state: 'needs-approval' })], { root: '/other' })), before)
  })
})

describe('the approval card', () => {
  it('says what approving lets happen, for a command and for an address', () => {
    assert.match(approvalWarning(server()), /run this command on your computer/)
    assert.match(approvalWarning(server({ summary: 'https://mcp.example.com/sse' })), /connect to this address/)
  })

  it('names the variables and headers an entry uses, never their values', () => {
    assert.equal(environmentLine(server()), '')
    assert.equal(environmentLine(server({ envNames: ['TOKEN'], variables: ['GITHUB_TOKEN'] })), 'It sets TOKEN, and reads GITHUB_TOKEN from your environment.')
    assert.equal(environmentLine(server({ headerNames: ['Authorization'] })), 'It sends the headers Authorization.')
  })
})

describe('the Add server form', () => {
  it('splits a command line at spaces, keeps quoted words whole, and says what is wrong', () => {
    assert.deepEqual(splitCommandLine('npx -y @modelcontextprotocol/server-filesystem .'), ['npx', '-y', '@modelcontextprotocol/server-filesystem', '.'])
    assert.deepEqual(splitCommandLine(`  "C:\\Program Files\\node\\node.exe"  server.js --name 'my server' ""`), ['C:\\Program Files\\node\\node.exe', 'server.js', '--name', 'my server', ''])
    assert.match(String(splitCommandLine('node "x')), /double quote is not closed/)
    assert.equal(typeof splitCommandLine('   '), 'string')
  })

  it('reads variables and headers one per line', () => {
    assert.deepEqual(parsePairs('TOKEN=${GITHUB_TOKEN}\n\nMODE = a=b\r\n', '='), { TOKEN: '${GITHUB_TOKEN}', MODE: 'a=b' })
    assert.deepEqual(parsePairs('Authorization: Bearer ${TOKEN}', ':'), { Authorization: 'Bearer ${TOKEN}' })
    assert.match(String(parsePairs('nothing here', '=')), /Line 1 needs NAME=value/)
    assert.match(String(parsePairs('A=1\nA=2', '=')), /twice/)
  })

  it('makes the entry, and names the values a project’s file would show to everyone', () => {
    const program = newServerOf({ kind: 'stdio', commandLine: 'npx -y server', env: 'TOKEN=abc\nHOME_DIR=${HOME}', url: '', headers: '' })
    assert.deepEqual(program, { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'abc', HOME_DIR: '${HOME}' } })
    assert.deepEqual(writtenValues(program as Exclude<typeof program, string>), ['TOKEN'])
    const web = newServerOf({ kind: 'http', commandLine: '', env: '', url: ' https://mcp.example.com/mcp ', headers: 'Authorization: Bearer ${TOKEN:-x}' })
    assert.deepEqual(web, { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN:-x}' } })
    assert.deepEqual(writtenValues(web as Exclude<typeof web, string>), [])
    assert.match(String(newServerOf({ kind: 'sse', commandLine: '', env: '', url: '', headers: '' })), /address/)
  })
})
