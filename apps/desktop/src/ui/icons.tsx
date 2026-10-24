/**
 * eNCode's own icon set (ADR 0013): line icons drawn on a 24 px grid with
 * round ends, coloured by `currentColor`. The line is sized so that it is
 * about 1.5 px on screen whatever size the icon is drawn at (see `weight`).
 * They replace lucide-react and keep its prop shape (`size`, `className`,
 * `fill`, `strokeWidth`), so call sites only change their import.
 */
import type { ReactNode, SVGProps } from 'react'
import { weight } from './icon-weight'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { size?: number | string }
export type Icon = ((props: IconProps) => ReactNode) & { displayName?: string }

function icon(name: string, children: ReactNode): Icon {
  const Component: Icon = ({ size = 16, strokeWidth, fill = 'none', className, ...rest }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth ?? weight(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : 'icon'}
      {...rest}
    >
      {children}
    </svg>
  )
  Component.displayName = name
  return Component
}

/** A filled dot that stays filled whatever `fill` the icon is given. */
const dot = (cx: number, cy: number, r = 1.3) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
const ring = (r = 8.5) => <circle cx="12" cy="12" r={r} />
const page = <path d="M7 3.5h6.5L18 8v12.5H7z M13.5 3.5V8H18" />
const shield = 'M12 3.5 19 6v5.5c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6z'
const folder = 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2h7.4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'
const frame = <rect x="4" y="4.5" width="16" height="15" rx="2.5" />

// Arrows and chevrons
export const ArrowLeft = icon('ArrowLeft', <path d="M19 12H5 M11 6l-6 6 6 6" />)
export const ArrowRight = icon('ArrowRight', <path d="M5 12h14 M13 6l6 6-6 6" />)
export const ArrowUp = icon('ArrowUp', <path d="M12 19V5 M6 11l6-6 6 6" />)
export const ArrowDown = icon('ArrowDown', <path d="M12 5v14 M6 13l6 6 6-6" />)
export const ChevronDown = icon('ChevronDown', <path d="M7 10l5 5 5-5" />)
export const ChevronUp = icon('ChevronUp', <path d="M7 14l5-5 5 5" />)
export const ChevronRight = icon('ChevronRight', <path d="M10 7l5 5-5 5" />)
export const ChevronLeft = icon('ChevronLeft', <path d="M14 7l-5 5 5 5" />)
export const ExternalLink = icon('ExternalLink', <path d="M14 4h6v6 M20 4l-8.5 8.5 M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5" />)
export const RefreshCw = icon('RefreshCw', <path d="M19.5 9A8 8 0 0 0 5 7.5 M4.5 4v4h4 M4.5 15A8 8 0 0 0 19 16.5 M19.5 20v-4h-4" />)
export const RotateCw = icon('RotateCw', <path d="M20 12a8 8 0 1 1-2.6-5.9 M20 4.5V9h-4.5" />)
export const Undo2 = icon('Undo2', <path d="M9.5 6.5 5 11l4.5 4.5 M5 11h9.5a4.5 4.5 0 0 1 0 9H12" />)
export const Flag = icon('Flag', <path d="M5.5 20.5v-16 M5.5 4.5h11.5l-2.5 4 2.5 4H5.5" />)
/** Into the flow: a message handed to the work that runs. */
export const CornerDownRight = icon('CornerDownRight', <path d="M5.5 5v6a3.5 3.5 0 0 0 3.5 3.5h9.5 M14.5 10.5l4 4-4 4" />)
export const Download = icon('Download', <path d="M12 4v11 M7.5 10.5 12 15l4.5-4.5 M5 19.5h14" />)
export const Maximize2 = icon('Maximize2', <path d="M14 4h6v6 M10 20H4v-6 M20 4l-6.5 6.5 M4 20l6.5-6.5" />)

// Marks and states
export const Plus = icon('Plus', <path d="M12 5v14 M5 12h14" />)
export const Minus = icon('Minus', <path d="M6 12h12" />)
export const X = icon('X', <path d="M7 7l10 10 M17 7 7 17" />)
export const Check = icon('Check', <path d="M5 12.5l4.5 4.5L19 7.5" />)
export const CheckCircle2 = icon('CheckCircle2', <>{ring()}<path d="M8.5 12.3l2.4 2.4 4.7-4.9" /></>)
export const XCircle = icon('XCircle', <>{ring()}<path d="M9.2 9.2l5.6 5.6 M14.8 9.2l-5.6 5.6" /></>)
export const Circle = icon('Circle', ring())
export const CircleDot = icon('CircleDot', <>{ring()}{dot(12, 12, 2.5)}</>)
export const AlertTriangle = icon('AlertTriangle', <><path d="M12 4 2.8 19.5h18.4z M12 10v4.5" />{dot(12, 17, 1)}</>)
export const Info = icon('Info', <><>{ring()}</><path d="M12 11v5" />{dot(12, 8, 1)}</>)
export const Loader2 = icon('Loader2', <path d="M20.5 12a8.5 8.5 0 1 1-6-8.13" />)
export const MoreHorizontal = icon('MoreHorizontal', <>{dot(5.5, 12, 1.8)}{dot(12, 12, 1.8)}{dot(18.5, 12, 1.8)}</>)
export const Star = icon('Star', <path d="M12 4l2.5 5.2 5.7.8-4.1 4 1 5.6L12 17l-5.1 2.6 1-5.6-4.1-4 5.7-.8z" />)
export const Target = icon('Target', <>{ring()}{ring(5)}{dot(12, 12, 1.5)}</>)
export const Gauge = icon('Gauge', <><path d="M4.5 17a8 8 0 1 1 15 0 M12 13l3.5-4" />{dot(12, 13, 1.3)}</>)
export const Activity = icon('Activity', <path d="M3 12h4l2.5-6 5 12L17 12h4" />)
export const Wifi = icon('Wifi', <><path d="M4.5 9.5a11 11 0 0 1 15 0 M7.5 12.8a6.5 6.5 0 0 1 9 0 M10.4 16a2.2 2.2 0 0 1 3.2 0" />{dot(12, 19, 1)}</>)

// Media and control
export const Play = icon('Play', <path d="M8 5.5v13l10-6.5z" />)
export const Pause = icon('Pause', <path d="M9 6v12 M15 6v12" />)
export const Square = icon('Square', <rect x="6" y="6" width="12" height="12" rx="2" />)

// Files and folders
export const File = icon('File', page)
export const FileText = icon('FileText', <>{page}<path d="M9.5 12.5h6 M9.5 16h4" /></>)
export const FileCode2 = icon('FileCode2', <>{page}<path d="M10.5 12.5 9 14l1.5 1.5 M14.5 12.5 16 14l-1.5 1.5" /></>)
export const FileJson = icon(
  'FileJson',
  <>
    {page}
    <path d="M10 12.5c-.8 0-1 .5-1 1v.5l-.8.5.8.5v.5c0 .5.2 1 1 1 M15 12.5c.8 0 1 .5 1 1v.5l.8.5-.8.5v.5c0 .5-.2 1-1 1" />
  </>,
)
export const FilePlus2 = icon('FilePlus2', <>{page}<path d="M12.5 12v6 M9.5 15h6" /></>)
export const FileUp = icon('FileUp', <>{page}<path d="M12.5 18v-6 M10 14.5l2.5-2.5 2.5 2.5" /></>)
export const Files = icon('Files', <path d="M9 7h6.5L19 10.5V20H9z M15.5 7v3.5H19 M6 16.5V4h7" />)
export const Folder = icon('Folder', <path d={folder} />)
export const FolderOpen = icon(
  'FolderOpen',
  <path d="M3.5 18.5v-11a2 2 0 0 1 2-2h3.6l2 2h6.4a2 2 0 0 1 2 2v1.5 M3.5 18.5l2.3-6.3a1.5 1.5 0 0 1 1.4-1h12.3a1 1 0 0 1 .95 1.3l-2 5.9a1.5 1.5 0 0 1-1.4 1.1z" />,
)
export const FolderPlus = icon('FolderPlus', <path d={`${folder} M12 10v5.5 M9.25 12.75h5.5`} />)
export const Picture = icon('Picture', <>{frame}{dot(9, 9.5, 1.5)}<path d="M4.5 17.5 9.5 13l3.5 3 2.5-2 4 3.5" /></>)
export const Paperclip = icon('Paperclip', <path d="M20 12l-7.5 7.5a5 5 0 0 1-7-7L13 5a3.5 3.5 0 0 1 5 5l-7.5 7.5a2 2 0 0 1-3-3L14 8" />)
export const Copy = icon('Copy', <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 5H6.5A1.5 1.5 0 0 0 5 6.5V15" /></>)
export const Trash2 = icon('Trash2', <path d="M4.5 7h15 M9.5 7V4.5h5V7 M6.5 7l1 12.5h9l1-12.5 M10.5 11v5 M13.5 11v5" />)
export const Pencil = icon('Pencil', <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z M13.5 7.5l3 3" />)
export const PenSquare = icon('PenSquare', <path d="M11 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h12a1.5 1.5 0 0 0 1.5-1.5v-5 M10 14l.5-3 7.5-7.5a1.8 1.8 0 0 1 2.5 2.5L13 13.5z" />)
export const Package = icon('Package', <path d="M12 3.5 20 7.5v9L12 20.5 4 16.5v-9z M4 7.5l8 4 8-4 M12 11.5v9" />)
export const ScrollText = icon('ScrollText', <path d="M7 4.5h11v12a3 3 0 0 1-3 3H6.5a2.5 2.5 0 0 1 0-5H15 M10 8.5h5 M10 11.5h5" />)
export const BookOpen = icon(
  'BookOpen',
  <path d="M3.5 5.5c3-.8 5.8-.3 8.5 1.5v12.5c-2.7-1.8-5.5-2.3-8.5-1.5z M20.5 5.5c-3-.8-5.8-.3-8.5 1.5v12.5c2.7-1.8 5.5-2.3 8.5-1.5z" />,
)

// Code, terminal and version control
export const Code2 = icon('Code2', <path d="M9 7l-5 5 5 5 M15 7l5 5-5 5 M13.5 5l-3 14" />)
export const Terminal = icon('Terminal', <path d="M5 7.5l4.5 4.5L5 16.5 M12 17h7" />)
export const SquareTerminal = icon('SquareTerminal', <><rect x="4" y="5" width="16" height="14" rx="2.5" /><path d="M7.5 9.5l3 2.5-3 2.5 M12.5 15h4" /></>)
export const GitBranch = icon('GitBranch', <><circle cx="17" cy="6" r="2" /><path d="M7 3.5v17 M17 8c0 5-10 3-10 9" /></>)
export const GitFork = icon(
  'GitFork',
  <>
    <circle cx="7" cy="5" r="2" />
    <circle cx="17" cy="5" r="2" />
    <circle cx="12" cy="19" r="2" />
    <path d="M7 7v1.5a3 3 0 0 0 3 3h4a3 3 0 0 0 3-3V7 M12 11.5V17" />
  </>,
)
export const GitPullRequest = icon(
  'GitPullRequest',
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="19" r="2" />
    <path d="M6 7v10 M18 17V9a3 3 0 0 0-3-3h-4 M13 3.5 10.5 6 13 8.5" />
  </>,
)
export const Regex = icon('Regex', <><path d="M17 4v8 M13.5 6l7 4 M20.5 6l-7 4" /><rect x="4" y="15" width="5" height="5" rx="1" /></>)
export const CaseSensitive = icon('CaseSensitive', <><path d="M3.5 17 7 7l3.5 10 M4.8 13.5h4.4" /><circle cx="16.5" cy="14" r="3" /><path d="M19.5 11v6" /></>)
export const ListTree = icon('ListTree', <path d="M9 6h11 M13 12h7 M13 18h7 M5 4.5v11.5a2 2 0 0 0 2 2h3 M5 12h5" />)
/** Sorting: an arrow down beside an arrow up. */
export const ArrowDownUp = icon('ArrowDownUp', <path d="M7 4v16 M3.5 16.5 7 20l3.5-3.5 M17 20V4 M13.5 7.5 17 4l3.5 3.5" />)
/** Folding every level shut: two chevrons pointing in. */
export const ChevronsDownUp = icon('ChevronsDownUp', <path d="M7 20l5-5 5 5 M7 4l5 5 5-5" />)
/** Following the cursor: a ring with its four marks. */
export const Crosshair = icon('Crosshair', <path d="M12 5.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M12 2.5v4 M12 17.5v4 M2.5 12h4 M17.5 12h4" />)
/** A line number: the number sign. */
export const Hash = icon('Hash', <path d="M4.5 9h15 M4.5 15h15 M10 4l-2 16 M16 4l-2 16" />)
export const ListTodo = icon(
  'ListTodo',
  <>
    <path d="M10 7h10 M10 12h10 M10 17h10 M4 6.5l1.2 1.2L7.5 5.4" />
    <rect x="4" y="10.5" width="3" height="3" rx=".7" />
    <rect x="4" y="15.5" width="3" height="3" rx=".7" />
  </>,
)
export const Network = icon(
  'Network',
  <>
    <circle cx="12" cy="5" r="2" />
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="18" r="2" />
    <path d="M12 7v4.5 M12 11.5l-5.6 5 M12 11.5l5.6 5" />
  </>,
)

// Layout and navigation
export const Menu = icon('Menu', <path d="M4 7h16 M4 12h16 M4 17h16" />)
export const Columns2 = icon('Columns2', <>{frame}<path d="M12 4.5v15" /></>)
export const LayoutGrid = icon(
  'LayoutGrid',
  <>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </>,
)
export const PanelBottom = icon('PanelBottom', <>{frame}<path d="M4 14.5h16" /></>)
export const PanelLeft = icon('PanelLeft', <>{frame}<path d="M9 4.5v15" /></>)
export const PanelRight = icon('PanelRight', <>{frame}<path d="M15 4.5v15" /></>)
export const PanelRightClose = icon('PanelRightClose', <>{frame}<path d="M15 4.5v15 M9 9.5l2.5 2.5L9 14.5" /></>)
export const Home = icon('Home', <path d="M4 10.5 12 4l8 6.5V20h-5v-6H9v6H4z" />)
export const Search = icon('Search', <path d="M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M20 20l-4.8-4.8" />)
export const Globe = icon('Globe', <>{ring()}<path d="M3.5 12h17 M12 3.5c2.6 2.4 2.6 14.6 0 17 M12 3.5c-2.6 2.4-2.6 14.6 0 17" /></>)
export const Clock = icon('Clock', <>{ring()}<path d="M12 7.5V12l3 2" /></>)
export const Bell = icon('Bell', <path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0" />)
export const Pin = icon('Pin', <path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5z M12 13v7.5" />)
export const Archive = icon('Archive', <path d="M4 5h16v4H4z M6 9v10h12V9 M10 13h4" />)
export const Keyboard = icon('Keyboard', <><rect x="3.5" y="6.5" width="17" height="11" rx="2" /><path d="M8 14h8" />{dot(7.5, 10)}{dot(10.5, 10)}{dot(13.5, 10)}{dot(16.5, 10)}</>)

// Appearance
export const Sun = icon(
  'Sun',
  <>
    <circle cx="12" cy="12" r="3.75" />
    <path d="M12 3v1.75 M12 19.25V21 M3 12h1.75 M19.25 12H21 M5.64 5.64l1.24 1.24 M17.12 17.12l1.24 1.24 M5.64 18.36l1.24-1.24 M17.12 6.88l1.24-1.24" />
  </>,
)
export const Moon = icon('Moon', <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />)
export const Monitor = icon('Monitor', <><rect x="3.5" y="4.5" width="17" height="11.5" rx="2" /><path d="M9 20h6 M12 16v4" /></>)
export const Contrast = icon('Contrast', <>{ring()}<path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" /></>)
export const Rows = icon('Rows', <path d="M4.5 6.5h15 M4.5 12h15 M4.5 17.5h15" />)
export const Palette = icon(
  'Palette',
  <>
    <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.3 0 1.9-.9 1.6-1.9-.4-1.3.4-2.6 1.8-2.6h1.7a3.4 3.4 0 0 0 3.4-3.4C20.5 7.6 16.7 3.5 12 3.5z" />
    {dot(8, 10.5)}
    {dot(12, 7.5)}
    {dot(16, 10.5)}
  </>,
)

// Settings and safety
/** Eight teeth around a hub: Settings. The outline is generated from its radii, not traced from another set. */
export const Gear = icon('Gear', <><path d="M10.4 4.78 L10.66 2.49 L13.34 2.49 L13.6 4.78A7.4 7.4 0 0 1 15.98 5.76 L17.78 4.33 L19.67 6.22 L18.24 8.02A7.4 7.4 0 0 1 19.22 10.4 L21.51 10.66 L21.51 13.34 L19.22 13.6A7.4 7.4 0 0 1 18.24 15.98 L19.67 17.78 L17.78 19.67 L15.98 18.24A7.4 7.4 0 0 1 13.6 19.22 L13.34 21.51 L10.66 21.51 L10.4 19.22A7.4 7.4 0 0 1 8.02 18.24 L6.22 19.67 L4.33 17.78 L5.76 15.98A7.4 7.4 0 0 1 4.78 13.6 L2.49 13.34 L2.49 10.66 L4.78 10.4A7.4 7.4 0 0 1 5.76 8.02 L4.33 6.22 L6.22 4.33 L8.02 5.76A7.4 7.4 0 0 1 10.4 4.78Z" /><circle cx="12" cy="12" r="2.9" /></>)
export const Settings2 = icon('Settings2', <><path d="M4 8h5 M13 8h7 M4 16h9 M17 16h3" /><circle cx="11" cy="8" r="2" /><circle cx="15" cy="16" r="2" /></>)
export const Shield = icon('Shield', <path d={shield} />)
export const ShieldAlert = icon('ShieldAlert', <><path d={`${shield} M12 8.5v4`} />{dot(12, 15.5, 1)}</>)
export const ShieldCheck = icon('ShieldCheck', <path d={`${shield} M9 12l2.2 2.2L15.5 10`} />)
export const Lock = icon('Lock', <path d="M6.5 11h11v9h-11z M9 11V8.5a3 3 0 0 1 6 0V11" />)
export const Key = icon('Key', <><circle cx="8.5" cy="14.5" r="3.5" /><path d="M11 12 19.5 3.5 M16 7l2.5 2.5 M13.8 9.2l1.7 1.7" /></>)
export const Eye = icon('Eye', <><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>)
export const EyeOff = icon(
  'EyeOff',
  <path d="M2.5 12s3.5-6.5 9.5-6.5c1.6 0 3 .4 4.3 1 M21.5 12s-3.5 6.5-9.5 6.5c-1.6 0-3-.4-4.3-1 M9.9 9.9a3 3 0 0 0 4.2 4.2 M4 4l16 16" />,
)

// Agent, models and plugins
export const Sparkles = icon(
  'Sparkles',
  <path d="M12 3.5l1.9 5.2 5.1 1.8-5.1 1.8L12 17.5l-1.9-5.2L5 10.5l5.1-1.8z M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />,
)
export const Bot = icon(
  'Bot',
  <>
    <rect x="5" y="9" width="14" height="10.5" rx="3.2" />
    <path d="M12 9V6.4 M9.3 13v1.7 M14.7 13v1.7 M2.8 13v2.7 M21.2 13v2.7" />
    <circle cx="12" cy="4.9" r="1.4" />
  </>,
)
/** A person: head and shoulders. */
export const UserRound = icon('UserRound', <path d="M12 12.5a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20a7.5 7.5 0 0 1 15 0" />)
/** Three bars on a base line. */
export const BarChart = icon('BarChart', <path d="M4 20h16 M7 16.5V11 M12 16.5V6 M17 16.5v-3.5" />)
/** The pointer of a mouse, with its tail. */
export const MousePointer = icon('MousePointer', <path d="M5.5 4.5 18 10l-5.5 1.8L10.5 18z M12.5 11.8l5 5" />)
export const Puzzle = icon('Puzzle', <path d="M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M16.5 13.5v6 M13.5 16.5h6" />)
export const Layers = icon('Layers', <path d="M12 3.5 3.5 8 12 12.5 20.5 8z M3.5 12 12 16.5 20.5 12 M3.5 16 12 20.5 20.5 16" />)
export const Bolt = icon('Bolt', <path d="M13 3 5 13h6l-1 8 8-10h-6z" />)
/** A fix the language server offers: a bulb with its two base rings. */
export const Lightbulb = icon('Lightbulb', <path d="M9.5 18.5h5 M10.5 21h3 M12 3.5a5.8 5.8 0 0 0-3.4 10.5c.6.5.9 1.2.9 1.9v.6h5v-.6c0-.7.3-1.4.9-1.9A5.8 5.8 0 0 0 12 3.5z" />)
/** Something that can be renamed or reshaped: a wrench, drawn for refactorings. */
export const Wrench = icon('Wrench', <path d="M15 4.5a4.5 4.5 0 0 0-4.2 6.1l-6.3 6.3a1.8 1.8 0 0 0 2.6 2.6l6.3-6.3a4.5 4.5 0 0 0 6.1-4.2l-2.7 2.7-2.6-.5-.5-2.6 2.7-2.7A4.5 4.5 0 0 0 15 4.5z" />)
export const Mic = icon('Mic', <path d="M12 3.5a2.8 2.8 0 0 0-2.8 2.8v5.4a2.8 2.8 0 0 0 5.6 0V6.3A2.8 2.8 0 0 0 12 3.5z M5.5 11.5a6.5 6.5 0 0 0 13 0 M12 18v2.5" />)
export const MessageSquare = icon('MessageSquare', <path d="M4 5.5h16v11H9l-5 4z" />)
export const MessageCircleQuestion = icon(
  'MessageCircleQuestion',
  <>
    <path d="M20.5 12a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.1-4.4A8.5 8.5 0 1 1 20.5 12z M9.7 9.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.4v.3" />
    {dot(12, 16.5, 1)}
  </>,
)
