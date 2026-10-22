/// <reference path="./assets.d.ts" />
/**
 * The C# the Windows sandbox helper is built from, embedded in the bundle. The helper is compiled on the machine the
 * first time a session needs it (see build.ts), so the program that runs is always one whose source is in this
 * repository.
 */
import acls from './helper/Acls.cs'
import json from './helper/Json.cs'
import labels from './helper/Labels.cs'
import native from './helper/Native.cs'
import probe from './helper/Probe.cs'
import program from './helper/Program.cs'
import runner from './helper/Runner.cs'
import sids from './helper/Sids.cs'
import tokens from './helper/Tokens.cs'
import manifest from './helper/helper.manifest'

export interface SourceFile {
  name: string
  text: string
}

export const HELPER_FILES: readonly SourceFile[] = [
  { name: 'Acls.cs', text: acls },
  { name: 'Json.cs', text: json },
  { name: 'Labels.cs', text: labels },
  { name: 'Native.cs', text: native },
  { name: 'Probe.cs', text: probe },
  { name: 'Program.cs', text: program },
  { name: 'Runner.cs', text: runner },
  { name: 'Sids.cs', text: sids },
  { name: 'Tokens.cs', text: tokens },
]

export const HELPER_MANIFEST: string = manifest
