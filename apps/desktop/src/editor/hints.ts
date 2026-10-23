import { T } from '@encode/editor'
import type { EditorInlayHint, EditorSemanticTokens } from '@shared/types'

/**
 * The editor's token kinds a semantic token is drawn as, by the index the host sends: the same list, in the same order,
 * as `SEMANTIC_KINDS` in @encode/lsp (a test holds the two together).
 */
export const SEMANTIC_KINDS = ['type', 'variable', 'property', 'constant', 'function', 'meta', 'keyword', 'comment', 'string', 'number', 'regexp', 'operator', 'bool', 'escape'] as const

/** The server's hints (0-based lines) as the view draws them (1-based). */
export function inlayHintsToView(hints: readonly EditorInlayHint[]): { line: number; col: number; label: string; kind?: 'type' | 'parameter'; paddingLeft?: boolean; paddingRight?: boolean }[] {
  return hints.map((hint) => ({
    line: hint.line + 1,
    col: hint.character,
    label: hint.label,
    ...(hint.kind ? { kind: hint.kind } : {}),
    ...(hint.paddingLeft ? { paddingLeft: true } : {}),
    ...(hint.paddingRight ? { paddingRight: true } : {}),
  }))
}

/** The host's tokens (0-based lines, kinds by index) as the view draws them (1-based lines, the editor's kinds). */
export function semanticTokensToView(tokens: EditorSemanticTokens): { line: number; from: number; to: number; kind: number; deprecated?: boolean }[] {
  const out: { line: number; from: number; to: number; kind: number; deprecated?: boolean }[] = []
  const data = tokens.data
  for (let index = 0; index + 4 < data.length; index += 5) {
    const name = SEMANTIC_KINDS[data[index + 3]]
    if (name === undefined) continue
    const from = data[index + 1]
    out.push({ line: data[index] + 1, from, to: from + data[index + 2], kind: T[name], ...(data[index + 4] & 1 ? { deprecated: true } : {}) })
  }
  return out
}
