/**
 * How every Node.js program of a run is debugged, the ones it starts included (`npm run dev` starts Node.js, which
 * starts the app): a small script of eNCode's own, loaded into each by NODE_OPTIONS before its own code. It opens the
 * program's inspector on a free port of 127.0.0.1, writes where to reach it into the run's folder, and waits for the
 * debugger, which places the breakpoints and lets it go. Worker threads, programs already being inspected, the
 * package managers themselves (npm, npx, pnpm, yarn, corepack) and tsx's command, which starts the program as another
 * Node.js, are left alone.
 *
 * V8 stops before an ES module with a source map runs, so that its breakpoints go in first; it does not for a CommonJS
 * module, which Node.js compiles as a function. So the script also stops the program before it compiles a CommonJS
 * module whose code names a source map (compiled TypeScript, tsx's), in a function the debugger knows by its name:
 * the debugger reads the module's file and map there, places its breakpoints by the module's name, and lets it go.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

/** The script; it runs in the debugged program, as CommonJS, before the program's own code. */
export const BOOTLOADER = String.raw`'use strict';
(function () {
  var dir = process.env.ENCODE_DEBUG_DIR;
  if (!dir) return;
  try { if (!require('worker_threads').isMainThread) return; } catch (e) {}
  var inspector = require('inspector');
  if (inspector.url()) return;
  var script = process.argv[1] || '';
  if (/[\\/](npm-cli|npx-cli|npm-prefix|yarn|pnpm|pnpx|corepack)(\.c?js)?$/i.test(script) || /[\\/]node_modules[\\/](npm|pnpm|yarn|corepack|@pnpm[\\/]exe)[\\/]/i.test(script) || /[\\/]node_modules[\\/]tsx[\\/]dist[\\/]cli\.[cm]?js$/i.test(script)) return;
  var fs = require('fs'), path = require('path');
  try { if (!fs.statSync(dir).isDirectory()) return; } catch (e) { return; }
  try { inspector.open(0, '127.0.0.1', false); } catch (e) { return; }
  var url = inspector.url();
  if (!url) return;
  var Module = null;
  try { Module = require('module'); } catch (e) {}
  if (Module && Module.prototype && typeof Module.prototype._compile === 'function') {
    var compile = Module.prototype._compile;
    var beforeModule = function __encodeBeforeModule(file, map) { debugger; };
    Module.prototype._compile = function (content, filename) {
      if (typeof content === 'string') {
        var at = content.lastIndexOf('sourceMappingURL=');
        if (at >= 0 && /\/\/[#@][ \t]*$/.test(content.slice(Math.max(0, at - 8), at))) {
          var end = content.indexOf('\n', at);
          var map = content.slice(at + 17, end < 0 ? undefined : end).trim();
          if (map) beforeModule(String(filename), map);
        }
      }
      return compile.apply(this, arguments);
    };
  }
  var options = (process.execArgv || []).join(' ') + ' ' + String(process.env.NODE_OPTIONS || '').replace(/--require\s+"[^"]*encode-debug-boot\.cjs"/g, '');
  var info = {
    pid: process.pid,
    ppid: process.ppid,
    url: url,
    argv: process.argv.slice(1, 8).map(function (arg) { return String(arg).slice(0, 300); }),
    cwd: process.cwd(),
    typescript: !!(process.features && process.features.typescript),
    loaders: /(^|\s)(--import|--loader|--experimental-loader|-r|--require)(\s|=)/.test(options)
  };
  var file = path.join(dir, process.pid + '.json');
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify(info));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    try { inspector.close(); } catch (e2) {}
    return;
  }
  inspector.waitForDebugger();
})();
`

/** What the bootloader writes of a program it opened the inspector of. */
export interface BootInfo {
  pid: number
  ppid: number
  /** `ws://127.0.0.1:<port>/<id>`. */
  url: string
  argv: string[]
  cwd: string
  /** The program strips TypeScript's types itself. */
  typescript: boolean
  /** It loads code of its own before the program's (tsx, ts-node), which may turn TypeScript into JavaScript. */
  loaders: boolean
}

/** The name of the bootloader's function in which it stops before a CommonJS module with a source map compiles. */
export const BEFORE_MODULE = '__encodeBeforeModule'
export const BOOTLOADER_NAME = 'encode-debug-boot.cjs'

/** Only the inspector of a program on this machine, as the bootloader opens it, is connected to. */
const INSPECTOR_URL = /^ws:\/\/127\.0\.0\.1:\d{1,5}\/[\w-]{1,100}$/

/** A program's file in the run's folder, read; null when it does not read as one the bootloader wrote. */
export function readBootInfo(text: string): BootInfo | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const info = raw as Partial<BootInfo> | null
  if (!info || typeof info !== 'object') return null
  if (!Number.isInteger(info.pid) || (info.pid ?? 0) <= 0 || typeof info.url !== 'string' || !INSPECTOR_URL.test(info.url)) return null
  return {
    pid: info.pid!,
    ppid: Number.isInteger(info.ppid) ? info.ppid! : 0,
    url: info.url,
    argv: Array.isArray(info.argv) ? info.argv.filter((arg): arg is string => typeof arg === 'string').slice(0, 8) : [],
    cwd: typeof info.cwd === 'string' ? info.cwd : '',
    typescript: info.typescript === true,
    loaders: info.loaders === true,
  }
}

/**
 * A path in NODE_OPTIONS: quoted, so that spaces survive, with Node.js's escapes inside the quotes. Windows paths take
 * forward slashes, which Node.js reads as well and which need no escape.
 */
export function nodeOptionsPath(file: string, platform: NodeJS.Platform): string {
  const spelled = platform === 'win32' ? file.replace(/\\/g, '/') : file
  return `"${spelled.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** NODE_OPTIONS with the bootloader required first, and what the person's environment had kept after it. */
export function withBootloader(existing: string | undefined, bootloader: string, platform: NodeJS.Platform): string {
  const own = `--require ${nodeOptionsPath(bootloader, platform)}`
  return existing?.trim() ? `${own} ${existing.trim()}` : own
}

/** Makes the run's folder (only its owner may open it) with the bootloader in it; answers the bootloader's path. */
export async function prepareRunFolder(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, BOOTLOADER_NAME)
  await fs.writeFile(file, BOOTLOADER, { mode: 0o600 })
  return file
}
