import type { EditorState } from '@encode/editor'

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The value of a snippet variable for a snippet that goes in at `at` of a file (its path in the folder), as the
 * TextMate names have it; undefined for a name it does not know, which the snippet then shows as a placeholder.
 * The clipboard is not read: it is empty here.
 */
export function snippetVariable(name: string, state: EditorState, path: string, at: { from: number; to: number }, now = new Date()): string | undefined {
  const file = path.split('/').pop() ?? path
  const dot = file.lastIndexOf('.')
  const line = state.doc.lineAt(at.from)
  const language = state.config.language
  switch (name) {
    case 'TM_FILENAME':
      return file
    case 'TM_FILENAME_BASE':
      return dot > 0 ? file.slice(0, dot) : file
    case 'TM_FILEPATH':
    case 'RELATIVE_FILEPATH':
      return path
    case 'TM_DIRECTORY':
      return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    case 'TM_LINE_INDEX':
      return String(line.number - 1)
    case 'TM_LINE_NUMBER':
      return String(line.number)
    case 'TM_CURRENT_LINE':
      return line.text
    case 'TM_CURRENT_WORD':
    case 'TM_SELECTED_TEXT':
      return state.doc.sliceString(at.from, at.to)
    case 'CLIPBOARD':
      return ''
    case 'CURRENT_YEAR':
      return String(now.getFullYear())
    case 'CURRENT_YEAR_SHORT':
      return pad(now.getFullYear() % 100)
    case 'CURRENT_MONTH':
      return pad(now.getMonth() + 1)
    case 'CURRENT_MONTH_NAME':
      return MONTHS[now.getMonth()]
    case 'CURRENT_MONTH_NAME_SHORT':
      return MONTHS[now.getMonth()].slice(0, 3)
    case 'CURRENT_DATE':
      return pad(now.getDate())
    case 'CURRENT_DAY_NAME':
      return DAYS[now.getDay()]
    case 'CURRENT_DAY_NAME_SHORT':
      return DAYS[now.getDay()].slice(0, 3)
    case 'CURRENT_HOUR':
      return pad(now.getHours())
    case 'CURRENT_MINUTE':
      return pad(now.getMinutes())
    case 'CURRENT_SECOND':
      return pad(now.getSeconds())
    case 'CURRENT_SECONDS_UNIX':
      return String(Math.floor(now.getTime() / 1000))
    case 'RANDOM':
      return String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
    case 'RANDOM_HEX':
      return Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')
    case 'UUID':
      return crypto.randomUUID()
    case 'LINE_COMMENT':
      return language.lineComment ?? ''
    case 'BLOCK_COMMENT_START':
      return language.blockComment?.[0] ?? ''
    case 'BLOCK_COMMENT_END':
      return language.blockComment?.[1] ?? ''
    default:
      return undefined
  }
}
