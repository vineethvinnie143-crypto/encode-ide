export { EditorState, Transaction, redo, undo, type EditorConfig, type EditorStateSpec, type TransactionSpec } from './state'
export { EditorSelection, SelectionRange } from './selection'
export { History, GROUP_DELAY_MS, historyNow, setHistoryClock, withHistoryClock, type HistoryGroup } from './history'
export { T, TOKEN_NAMES, TokenBuilder, plainText, type Language, type LineTokens, type TokenName, type Tokenizer } from './language'
export {
  Highlighter,
  MAX_BATCH_CHARS,
  MAX_BATCH_LINES,
  MAX_TOKENIZED_LINE,
  sliceTokens,
  tokenizeBatch,
  type HighlightBatch,
  type HighlightResult,
  type HighlightService,
  type HighlightedLine,
  type LineBrackets,
} from './highlight'
export { BATCH_TIMEOUT_MS, connectHighlighting, serveHighlighting, type HighlightConnection, type HighlightPort, type HighlightWorkerPort } from './highlight-worker'
export {
  MAX_FOLD_RANGES,
  allFoldRanges,
  enclosingIndentRanges,
  foldDepths,
  foldRangeAt,
  isRegionEnd,
  isRegionStart,
  lineIndent,
  mapFoldRanges,
  mapFolded,
  normalizeFoldRanges,
  rangeStartingAt,
  rangesContaining,
  type FoldRange,
} from './folding'
export { bracketAt, findMatching, type BracketPair } from './brackets'
export {
  compileSearch,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  replacementFor,
  searchMatches,
  type CompiledSearch,
  type SearchMatch,
  type SearchQuery,
} from './search'
export * from './commands'
export {
  acceptHunk,
  rejectHunks,
  replaceLines,
  reviewHunks,
  reviewStats,
  wordChanges,
  type ReviewHunk,
  type ReviewResult,
  type WordChange,
} from './review'
export { reload, reloadChanges } from './reload'
export { parseSnippet, type Snippet, type SnippetOptions, type SnippetRange, type SnippetStop } from './snippet'
export { fuzzyMatch, type FuzzyMatch } from './fuzzy'
export { detectIndent, type IndentStyle } from './indent'
export { languageById, languageByName, languageForContent, languageForPath, languages, plain, type LanguageEntry } from './languages'
export {
  CharClass,
  carryColumnIndexes,
  charClass,
  columnAt,
  forgetColumnIndexes,
  indentWidth,
  indexAtColumn,
  leadingWhitespace,
  nextCluster,
  previousCluster,
  unitWidth,
  wordAround,
} from './text-utils'
export {
  TRACE_COMMANDS,
  TraceRecorder,
  TraceReplayer,
  editorProblems,
  expectOf,
  hashText,
  replayTrace,
  scrambleTrace,
  traceStart,
  type EditorTrace,
  type ProblemOptions,
  type ReplayOptions,
  type ReplayResult,
  type TraceAction,
  type TraceCommand,
  type TraceProblem,
  type TraceStep,
} from './trace'
