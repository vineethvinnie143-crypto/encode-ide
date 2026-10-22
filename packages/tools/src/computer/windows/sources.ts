/// <reference path="./assets.d.ts" />
/**
 * The C# the Windows desktop helper is built from, embedded in the bundle. The helper is compiled the first time
 * a session uses the desktop (see build.ts), so the program that runs is always one whose source is in this repository.
 */
import actions from './helper/Actions.cs'
import errors from './helper/Errors.cs'
import geometry from './helper/Geometry.cs'
import imaging from './helper/Imaging.cs'
import input from './helper/Input.cs'
import json from './helper/Json.cs'
import keys from './helper/Keys.cs'
import native from './helper/Native.cs'
import outline from './helper/Outline.cs'
import program from './helper/Program.cs'
import session from './helper/Session.cs'
import uia from './helper/Uia.cs'
import windows from './helper/Windows.cs'
import manifest from './helper/helper.manifest'

export interface SourceFile {
  name: string
  text: string
}

export const HELPER_FILES: readonly SourceFile[] = [
  { name: 'Actions.cs', text: actions },
  { name: 'Errors.cs', text: errors },
  { name: 'Geometry.cs', text: geometry },
  { name: 'Imaging.cs', text: imaging },
  { name: 'Input.cs', text: input },
  { name: 'Json.cs', text: json },
  { name: 'Keys.cs', text: keys },
  { name: 'Native.cs', text: native },
  { name: 'Outline.cs', text: outline },
  { name: 'Program.cs', text: program },
  { name: 'Session.cs', text: session },
  { name: 'Uia.cs', text: uia },
  { name: 'Windows.cs', text: windows },
]

export const HELPER_MANIFEST: string = manifest
