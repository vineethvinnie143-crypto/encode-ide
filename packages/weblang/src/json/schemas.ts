/**
 * The schemas eNCode knows without asking anything: written here, by eNCode, for the files its users open most. A
 * document's own `$schema` naming one of these (by its usual address) gets it too; any other address is not fetched.
 */
import type { Schema } from './schema'

const stringMap: Schema = { type: 'object', additionalProperties: { type: 'string' } }
const people: Schema = {
  anyOf: [
    { type: 'string', description: 'A name, with an email in <> and a web address in () when wanted.' },
    { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' }, url: { type: 'string', format: 'uri' } }, required: ['name'] },
  ],
}

export const PACKAGE_JSON: Schema = {
  title: 'package.json',
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 214, pattern: '^(?:@[a-z0-9-*~][a-z0-9-*._~]*/)?[a-z0-9-~][a-z0-9-._~]*$', description: 'The package\'s name: lower case, URL-safe, at most 214 characters, with an optional `@scope/`.' },
    version: { type: 'string', description: 'The version, as semver reads it: `1.2.3`.' },
    description: { type: 'string', description: 'What the package is, for people searching the registry.' },
    keywords: { type: 'array', items: { type: 'string' }, description: 'Words people may search the registry for.' },
    homepage: { type: 'string', description: 'The project\'s web page.' },
    bugs: { anyOf: [{ type: 'string' }, { type: 'object', properties: { url: { type: 'string' }, email: { type: 'string' } } }], description: 'Where to report problems.' },
    license: { type: 'string', description: 'An SPDX license expression, such as `MIT` or `(MIT OR Apache-2.0)`, or `UNLICENSED`.' },
    author: { ...people, description: 'The person who wrote it.' },
    contributors: { type: 'array', items: people, description: 'Others who worked on it.' },
    funding: { description: 'Where to support the package.' },
    files: { type: 'array', items: { type: 'string' }, description: 'The files the published package holds, as patterns.' },
    main: { type: 'string', description: 'The module loaded by `require` of the package.' },
    module: { type: 'string', description: 'The ES module entry bundlers prefer.' },
    browser: { description: 'The entry, or replacements, for browsers.' },
    types: { type: 'string', description: 'The TypeScript declarations of the entry.' },
    typings: { type: 'string', description: 'Older name of `types`.' },
    exports: { description: 'What the package exports, by subpath and condition (`import`, `require`, `types`, `default`). Anything not listed cannot be imported.' },
    imports: { type: 'object', description: 'Private imports starting with `#`, by condition.' },
    type: { enum: ['module', 'commonjs'], description: 'How `.js` files are read: `module` for ES modules, `commonjs` (the default) for CommonJS.' },
    bin: { anyOf: [{ type: 'string' }, stringMap], description: 'Commands the package installs, by name.' },
    man: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    directories: { type: 'object' },
    repository: { anyOf: [{ type: 'string' }, { type: 'object', properties: { type: { type: 'string' }, url: { type: 'string' }, directory: { type: 'string' } } }], description: 'Where the code is.' },
    scripts: { ...stringMap, description: 'Commands `npm run` runs, by name. `pre` and `post` scripts run before and after one of the same name.' },
    config: { type: 'object', description: 'Values scripts read as `npm_package_config_*`.' },
    dependencies: { ...stringMap, description: 'Packages it needs to run, by name and version range.' },
    devDependencies: { ...stringMap, description: 'Packages it needs only to be built or tested.' },
    peerDependencies: { ...stringMap, description: 'Packages the host project must have, in a range this one works with.' },
    peerDependenciesMeta: { type: 'object', additionalProperties: { type: 'object', properties: { optional: { type: 'boolean' } } } },
    optionalDependencies: { ...stringMap, description: 'Packages it uses when they install; a failure to install one is not an error.' },
    bundleDependencies: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'boolean' }] },
    overrides: { type: 'object', description: 'Versions to use for packages anywhere in the tree (npm).' },
    resolutions: { type: 'object', description: 'Versions to use for packages anywhere in the tree (Yarn).' },
    engines: { ...stringMap, description: 'The versions of Node.js (and npm) it works with.' },
    os: { type: 'array', items: { type: 'string' } },
    cpu: { type: 'array', items: { type: 'string' } },
    private: { type: 'boolean', description: '`true` stops it being published.' },
    publishConfig: { type: 'object' },
    workspaces: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object' }], description: 'Folders of packages in this repository.' },
    packageManager: { type: 'string', pattern: '^(npm|pnpm|yarn|bun)@\\d+\\.\\d+\\.\\d+(-.+)?(\\+.+)?$', description: 'The package manager and version Corepack uses: `pnpm@9.1.0`.' },
    sideEffects: { anyOf: [{ type: 'boolean' }, { type: 'array', items: { type: 'string' } }], description: '`false` lets bundlers drop modules nothing uses.' },
  },
}

const compilerOptions: Schema = {
  type: 'object',
  properties: {
    target: { type: 'string', enum: ['es3', 'es5', 'es6', 'es2015', 'es2016', 'es2017', 'es2018', 'es2019', 'es2020', 'es2021', 'es2022', 'es2023', 'es2024', 'esnext', 'ES3', 'ES5', 'ES6', 'ES2015', 'ES2016', 'ES2017', 'ES2018', 'ES2019', 'ES2020', 'ES2021', 'ES2022', 'ES2023', 'ES2024', 'ESNext'], description: 'The JavaScript version the output is written for.' },
    module: { type: 'string', enum: ['none', 'commonjs', 'amd', 'umd', 'system', 'es6', 'es2015', 'es2020', 'es2022', 'esnext', 'node16', 'node18', 'node20', 'nodenext', 'preserve', 'CommonJS', 'AMD', 'UMD', 'System', 'ES6', 'ES2015', 'ES2020', 'ES2022', 'ESNext', 'Node16', 'Node18', 'Node20', 'NodeNext', 'Preserve', 'None'], description: 'The module system of the output.' },
    moduleResolution: { type: 'string', enum: ['classic', 'node', 'node10', 'node16', 'nodenext', 'bundler', 'Classic', 'Node', 'Node10', 'Node16', 'NodeNext', 'Bundler'], description: 'How imports are found.' },
    lib: { type: 'array', items: { type: 'string' }, description: 'The library declarations the program sees (`DOM`, `ES2022`...).' },
    jsx: { enum: ['preserve', 'react', 'react-native', 'react-jsx', 'react-jsxdev'], description: 'How JSX is written out.' },
    jsxImportSource: { type: 'string' },
    strict: { type: 'boolean', description: 'Turns on every strict check.' },
    noImplicitAny: { type: 'boolean' },
    strictNullChecks: { type: 'boolean' },
    noUncheckedIndexedAccess: { type: 'boolean', description: 'An index read may be `undefined`.' },
    exactOptionalPropertyTypes: { type: 'boolean' },
    noUnusedLocals: { type: 'boolean' },
    noUnusedParameters: { type: 'boolean' },
    noImplicitReturns: { type: 'boolean' },
    noFallthroughCasesInSwitch: { type: 'boolean' },
    noEmit: { type: 'boolean', description: 'Checks only; writes nothing.' },
    declaration: { type: 'boolean', description: 'Writes `.d.ts` files.' },
    declarationMap: { type: 'boolean' },
    sourceMap: { type: 'boolean' },
    outDir: { type: 'string', description: 'Where output goes.' },
    rootDir: { type: 'string' },
    baseUrl: { type: 'string' },
    paths: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Import paths mapped to files, relative to `baseUrl` or this file.' },
    types: { type: 'array', items: { type: 'string' }, description: 'The only `@types` packages included.' },
    typeRoots: { type: 'array', items: { type: 'string' } },
    allowJs: { type: 'boolean' },
    checkJs: { type: 'boolean' },
    esModuleInterop: { type: 'boolean' },
    allowSyntheticDefaultImports: { type: 'boolean' },
    resolveJsonModule: { type: 'boolean' },
    isolatedModules: { type: 'boolean', description: 'Each file can be compiled on its own, as bundlers do.' },
    verbatimModuleSyntax: { type: 'boolean' },
    skipLibCheck: { type: 'boolean', description: 'Skips checking `.d.ts` files.' },
    forceConsistentCasingInFileNames: { type: 'boolean' },
    incremental: { type: 'boolean' },
    composite: { type: 'boolean' },
    tsBuildInfoFile: { type: 'string' },
    experimentalDecorators: { type: 'boolean' },
    emitDecoratorMetadata: { type: 'boolean' },
    useDefineForClassFields: { type: 'boolean' },
    allowImportingTsExtensions: { type: 'boolean' },
    moduleDetection: { enum: ['auto', 'legacy', 'force'] },
    newLine: { enum: ['crlf', 'lf', 'CRLF', 'LF'] },
    removeComments: { type: 'boolean' },
    downlevelIteration: { type: 'boolean' },
    importHelpers: { type: 'boolean' },
    plugins: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
  },
}

export const TSCONFIG_JSON: Schema = {
  title: 'tsconfig.json',
  type: 'object',
  properties: {
    extends: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: 'Settings this file starts from, by path or package.' },
    compilerOptions: { ...compilerOptions, description: 'How TypeScript checks and writes the program.' },
    include: { type: 'array', items: { type: 'string' }, description: 'The files in the program, as patterns.' },
    exclude: { type: 'array', items: { type: 'string' }, description: 'Files `include` finds that are left out.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Files in the program, by path.' },
    references: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, prepend: { type: 'boolean' } }, required: ['path'] }, description: 'Projects this one builds on.' },
    watchOptions: { type: 'object' },
    typeAcquisition: { type: 'object' },
    compileOnSave: { type: 'boolean' },
  },
}

/** The built-in schema for a file, by its name (and the folder name where that decides), or by a `$schema` address. */
export function builtinSchema(fileName: string, address?: string): Schema | null {
  if (address) {
    const key = address.replace(/^https?:\/\//, '').replace(/\.json$/, '').toLowerCase()
    if (key === 'json.schemastore.org/package' || key === 'www.schemastore.org/package') return PACKAGE_JSON
    if (key === 'json.schemastore.org/tsconfig' || key === 'www.schemastore.org/tsconfig') return TSCONFIG_JSON
  }
  const name = fileName.toLowerCase()
  if (name === 'package.json') return PACKAGE_JSON
  if (/^(tsconfig|jsconfig)(\..+)?\.json$/.test(name)) return TSCONFIG_JSON
  return null
}

/** Files read as JSON with comments whatever their extension: the TypeScript and editor settings that allow them. */
export function allowsComments(fileName: string, languageId: string): boolean {
  if (languageId === 'jsonc') return true
  return /^(tsconfig|jsconfig)(\..+)?\.json$|^\.?(eslintrc|babelrc|swcrc)(\.json)?$|^(settings|launch|tasks|extensions|keybindings)\.json$|^\.?devcontainer\.json$|^turbo\.json$|^biome\.json$/i.test(fileName)
}
