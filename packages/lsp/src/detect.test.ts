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
