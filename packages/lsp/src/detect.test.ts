import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { detectLanguages } from './detect'

function tree(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-detect-'))
  for (const file of files) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), '')
  }
  return root
}

describe('which languages a folder uses', () => {
  it('counts the files each server covers, names the files that mark a project, and skips packages and builds', async () => {
    const root = tree([
      '[ox]/ox_lib/fxmanifest.lua',
      '[ox]/ox_lib/init.lua',
      '[ox]/ox_lib/client/main.lua',
      'resources/web/package.json',
      'resources/web/src/App.tsx',
      'resources/web/node_modules/react/index.js',
      'resources/web/node_modules/react/types.d.ts',
      'resources/web/dist/assets/index.js',
      'tools/build.py',
      '.git/hooks/pre-commit.sh',
      'api/Api.csproj',
      'api/bin/Debug/Thing.cs',
    ])
    try {
      const found = await detectLanguages(root)
      assert.equal(found.partial, false)
      assert.deepEqual(found.used, [
        { id: 'lua', files: 3, markers: ['fxmanifest.lua'] },
        { id: 'python', files: 1, markers: [] },
        { id: 'typescript', files: 1, markers: ['package.json'] },
        // package.json is JSON, which eNCode's own server reads (ADR 0085).
        { id: 'web', files: 1, markers: [] },
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts a companion\'s files where a project of its kind is anywhere in the folder, and nowhere else', async () => {
    // A FiveM server folder whose resource has a web page built with Tailwind, by its config or by its package.
    const configured = tree(['server.cfg', 'resources/[ui]/hud/fxmanifest.lua', 'resources/[ui]/hud/web/tailwind.config.js', 'resources/[ui]/hud/web/src/App.tsx', 'resources/[ui]/hud/web/src/index.css', 'resources/[ui]/hud/web/src/main.ts'])
    const packaged = tree(['resources/hud/web/src/App.tsx', 'resources/hud/web/src/app.css'])
    fs.writeFileSync(path.join(packaged, 'resources/hud/web/package.json'), JSON.stringify({ devDependencies: { tailwindcss: '^4.1.0' } }))
    const plain = tree(['web/src/App.tsx', 'web/src/app.css'])
    fs.writeFileSync(path.join(plain, 'web/package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }))
    try {
      const tailwind = async (root: string) => (await detectLanguages(root)).used.find((item) => item.id === 'tailwind')
      // App.tsx and index.css: main.ts is TypeScript without JSX, which Tailwind is not given.
      assert.deepEqual(await tailwind(configured), { id: 'tailwind', files: 2, markers: ['tailwind.config.js'] })
      assert.deepEqual(await tailwind(packaged), { id: 'tailwind', files: 2, markers: [] })
      assert.equal(await tailwind(plain), undefined)
    } finally {
      for (const root of [configured, packaged, plain]) fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('stops after so many entries and says so', async () => {
    const root = tree(Array.from({ length: 40 }, (_, index) => `d${index}/f${index}.go`))
    try {
      const found = await detectLanguages(root, { maxEntries: 10 })
      assert.equal(found.partial, true)
      assert.ok((found.used[0]?.files ?? 0) < 40)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
