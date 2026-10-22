import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { isGuardedPath, isInside, isProtectedPath } from './paths'

describe('isInside', () => {
  it('follows POSIX path rules', () => {
    const inside = (target: string) => isInside('/ws', target, path.posix)
    assert.equal(inside('/ws'), true)
    assert.equal(inside('/ws/a/b'), true)
    assert.equal(inside('/ws/..foo'), true)
    assert.equal(inside('/ws/a/../..'), false)
    assert.equal(inside('/wsx'), false)
    assert.equal(inside('/etc/passwd'), false)
  })

  it('follows Windows path rules', () => {
    const inside = (target: string) => isInside('C:\\ws', target, path.win32)
    assert.equal(inside('C:\\ws\\a'), true)
    assert.equal(inside('c:/WS/a'), true)
    assert.equal(inside('C:\\wsx'), false)
    assert.equal(inside('D:\\ws\\a'), false)
    assert.equal(inside('\\\\server\\share\\ws'), false)
    assert.equal(inside('\\\\?\\C:\\ws\\a'), false)
    assert.equal(inside('\\ws\\a'), false)
    assert.equal(inside('C:ws\\a'), false)
  })
})

describe('isProtectedPath', () => {
  it('covers .git and .eNCode anywhere in the path, in any case', () => {
    for (const target of ['.git/config', '.git', 'sub/.git/hooks/pre-commit', '.GIT/config', '.eNCode/skills/x.md', '.encode', 'a\\.Git\\HEAD']) {
      assert.equal(isProtectedPath(target), true, target)
    }
  })

  it('sees through the spellings Windows normalises', () => {
    for (const target of ['.git./config', '.git /config', '.git::$INDEX_ALLOCATION/config', '.git:stream']) {
      assert.equal(isProtectedPath(target), true, target)
    }
  })

  it('leaves ordinary files alone', () => {
    for (const target of ['.gitignore', '.github/workflows/ci.yml', 'src/git.ts', 'encode.md', '..', '.']) {
      assert.equal(isProtectedPath(target), false, target)
    }
  })
})

describe('isGuardedPath', () => {
  it('covers the protected folders and the MCP file at the top of the workspace, spelled any way Windows reads it', () => {
    for (const target of ['.git/config', '.encode/mcp.json', '.mcp.json', './.mcp.json', '.MCP.JSON', '.mcp.json.', '.mcp.json ', '.mcp.json::$DATA', '.mcp.json:stream', '.\\.mcp.json']) {
      assert.equal(isGuardedPath(target), true, target)
    }
  })

  it('leaves the rest alone, and a file of that name further down', () => {
    for (const target of ['mcp.json', 'sub/.mcp.json', 'src/.mcp.json.bak', '.mcp.jsonl', '.mcp', 'x.mcp.json', '..', '.']) {
      assert.equal(isGuardedPath(target), false, target)
    }
  })

  it('does not widen what a rewind leaves alone', () => {
    assert.equal(isProtectedPath('.mcp.json'), false)
  })
})
