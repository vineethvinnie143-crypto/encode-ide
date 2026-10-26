/**
 * The agent's scratch folder from the command line (ADR 0141): in the sandbox's temp folder inside eNCode's own, where a
 * command may name it, and in the sandbox, where it may read and write it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import { createScriptedClient, DEFAULT_SETTINGS, toldScratch, type AgentEvent } from '@encode/core'
import { openRuntime, type Runtime } from './runtime'

let runtime: Runtime | undefined
const made: string[] = []
after(async () => {
  await runtime?.close()
  await Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

it('runs a probe from the scratch folder that imports the project, and writes there, in the sandbox where there is one', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'encode-cli-scratch-')))
  made.push(dir)
  const home = path.join(dir, 'home')
  const project = path.join(dir, 'project')
  await fs.mkdir(home)
  await fs.mkdir(project)
  await fs.writeFile(path.join(project, 'slug.mjs'), 'export const slug = (title) => title.toLowerCase()\n')
  let folder = ''
  let step = 0
  const client = createScriptedClient((request) => {
    if (request.role !== 'main') return { text: '' }
    folder ||= toldScratch(request.payload.messages) ?? ''
    const probe = path.join(folder, 'probe.mjs')
    switch (step++) {
      case 0: {
        const content = [`import { slug } from ${JSON.stringify(pathToFileURL(path.join(project, 'slug.mjs')).href)}`, "import fs from 'node:fs'", "fs.writeFileSync(new URL('./out.txt', import.meta.url), slug('A - B'))", ''].join('\n')
        return { calls: [{ name: 'Write', input: { file_path: probe, content } }] }
      }
      case 1:
        return { calls: [{ name: 'Bash', input: { command: `node "${probe}"`, description: 'Try slug on a title with a dash' } }] }
      default:
        return { text: 'Probed.' }
    }
  })
  const events: AgentEvent[] = []
  runtime = await openRuntime({ root: project, home, client, settings: () => ({ ...DEFAULT_SETTINGS, policy: 'full-access' }), emit: (event) => events.push(event), sandbox: true, nameSessions: false, warn: () => undefined, env: process.env })
  const session = await runtime.host.create({ projectRoot: project })
  await runtime.host.start(session.id, { text: 'try slug', mode: 'code' })
  assert.equal(folder, path.join(home, '.encode', 'cli', 'sandbox', 'tmp', 'scratch', session.id))
  const failed = events.filter((event) => event.type === 'entry' && event.entry.tool?.state === 'error').map((event) => (event.type === 'entry' ? event.entry.tool?.output : ''))
  assert.deepEqual(failed, [], `ran ${runtime.sandbox?.state === 'active' ? 'in' : 'outside'} the sandbox`)
  assert.equal(await fs.readFile(path.join(folder, 'out.txt'), 'utf8'), 'a - b')
  // Nothing of it is in the project.
  assert.deepEqual(await fs.readdir(project), ['slug.mjs'])
})
