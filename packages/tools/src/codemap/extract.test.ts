import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extract, languageOf } from './extract'
import { codeOnly, SYNTAX } from './lexer'

/** `kind name` (or `kind parent.name`) of each definition, in order. */
const shown = (file: string, text: string) =>
  extract(file, text)!.definitions.map((definition) => `${definition.line} ${definition.kind} ${definition.parent ? `${definition.parent}.` : ''}${definition.name}${definition.private ? ' (private)' : ''}`)

describe('the code of a file without comments and strings', () => {
  it('keeps every character in its place, and a string its quotes', () => {
    const text = 'const a = "x { y" // a { comment\nconst b = `t ${c + "}"} u` /* z */ + /re{/g.test(d)\n'
    const code = codeOnly(text, SYNTAX.js)
    assert.equal(code.length, text.length)
    assert.equal(code.split('\n').length, text.split('\n').length)
    assert.equal(code.replace(/ +/g, ' '), 'const a = " " \nconst b = ` ${c + " "} ` + / /g.test(d)\n')
  })

  it('reads each family: Python, Lua, Rust, shell, C#', () => {
    assert.equal(codeOnly('x = """a\n{b}""" # c\ny', SYNTAX.python).replace(/ +/g, ' '), 'x = """ \n """ \ny')
    assert.equal(codeOnly("a = [[x\n]] -- c\n--[==[ long\n]==] b = 'q'", SYNTAX.lua).replace(/ +/g, ' '), 'a = [[ \n]] \n \n b = \' \'')
    assert.equal(codeOnly("fn f<'a>(x: &'a str) -> char { 'x' } r#\"{\"#", SYNTAX.rust).replace(/ +/g, ' '), "fn f<'a>(x: &'a str) -> char { ' ' } r#\" \"#")
    assert.equal(codeOnly('echo $# "a # b" # note\nf() {', SYNTAX.shell).replace(/ +/g, ' '), 'echo $# " " \nf() {')
    assert.equal(codeOnly('var p = @"C:\\a ""{"" b"; // x', SYNTAX.csharp).replace(/ +/g, ' '), 'var p = @" "; ')
  })

  it('ends an unclosed string at its line, so the rest of the file still counts', () => {
    assert.equal(codeOnly("const a = 'it\nfunction b() {}", SYNTAX.js).split('\n')[1], 'function b() {}')
  })
})

describe('the definitions of a file', () => {
  it('TypeScript: exports, classes and their methods, arrows, types; nothing from comments, strings or bodies', () => {
    const text = [
      '// function commented() {}',
      'export interface Options { a: string }',
      'export type Mode = "a" | "b"',
      'export class Router extends Base {',
      '  private readonly seen = new Map<string, number>()',
      '  constructor(private options: Options) { super() }',
      '  async route(request: Request): Promise<Response> {',
      '    function inner() {}',
      '    return fetch("function fake() {}")',
      '  }',
      '  #hidden() {}',
      '  handle = (event: Event) => this.route(event)',
      '}',
      'export const createRouter = (options: Options): Router => new Router(options)',
      'const helper = async () => 1',
      'export const LIMIT = 10',
      'export default function main() {}',
      'export enum Color { Red }',
    ].join('\n')
    assert.deepEqual(shown('src/router.ts', text), [
      '2 interface Options',
      '3 type Mode',
      '4 class Router',
      '6 method Router.constructor',
      '7 method Router.route',
      '11 method Router.#hidden (private)',
      '12 method Router.handle',
      '14 function createRouter',
      '15 function helper (private)',
      '16 constant LIMIT',
      '17 function main',
      '18 enum Color',
    ])
    const route = extract('src/router.ts', text)!.definitions.find((definition) => definition.name === 'route')!
    assert.equal(route.text, 'async route(request: Request): Promise<Response>')
  })

  it('Python: classes, methods, functions and constants, by indentation', () => {
    const text = ['MAX_SIZE = 10', 'class Store(Base):', '    """def not_this(): pass"""', '    def get(self, key):', '        def inner(): pass', '        return 1', '    def _cache(self):', '        pass', 'async def main():', '    pass'].join('\n')
    assert.deepEqual(shown('store.py', text), ['1 constant MAX_SIZE', '2 class Store', '4 method Store.get', '7 method Store._cache (private)', '9 function main'])
    assert.equal(extract('store.py', text)!.definitions[1].text, 'class Store(Base)')
  })

  it('Lua and FiveM: functions, tables, and what a resource registers by name', () => {
    const text = [
      'Config = {}',
      'local function notify(source, msg) end',
      'function QBCore.Functions.GetPlayer(source)',
      '  local function inner() end',
      'end',
      'function Player:save() end',
      "RegisterNetEvent('garage:server:park', function(plate)",
      "  TriggerClientEvent('garage:client:parked', source, plate)",
      'end)',
      "AddEventHandler('garage:server:park', function() end)",
      "RegisterCommand('park', function() end, false)",
      "lib.callback.register('garage:getVehicles', function(source) end)",
      "lib.addCommand('impound', { help = 'Impound' }, function(source) end)",
      "QBCore.Commands.Add('depot', 'Send to depot', {}, false, function(source) end)",
      "exports('GetGarage', function() end)",
      "-- RegisterNetEvent('commented:out')",
      "local data = exports['qb-core']:GetCoreObject()",
      'Config.Garages = {',
      "  ['pillbox'] = {",
      '    spawnPoint = { vector4(0, 0, 0, 0) },',
      '  },',
      '}',
    ].join('\n')
    assert.deepEqual(shown('server/main.lua', text), [
      '1 table Config',
      '2 function notify (private)',
      '3 function QBCore.Functions.GetPlayer',
      '6 function Player.save',
      '7 event garage:server:park',
      '11 command park',
      '12 callback garage:getVehicles',
      '13 command impound',
      '14 command depot',
      '15 export GetGarage',
    ])
    const names = extract('server/main.lua', text)!.names
    assert.equal(names.get('garage:client:parked'), 1)
    assert.equal(names.get('GetCoreObject'), 2)
    assert.ok(!names.has('commented'))
  })

  it('Rust, Go, C, C++, Java, C#, Kotlin, PHP, Ruby, shell and SQL', () => {
    assert.deepEqual(shown('lib.rs', ['pub struct Router {', '  routes: Vec<Route>,', '}', 'impl Display for Router {', '  fn fmt(&self) {}', '}', 'pub fn route() {}', 'fn helper() {}', 'pub trait Handler {', '  fn handle(&self);', '}', 'macro_rules! log {}'].join('\n')), [
      '1 struct Router',
      '4 impl Router',
      '5 method Router.fmt (private)',
      '7 function route',
      '8 function helper (private)',
      '9 trait Handler',
      '10 method Handler.handle (private)',
      '12 macro log',
    ])
    assert.deepEqual(shown('main.go', ['type Server struct {', '  addr string', '}', 'func (s *Server) Start() error {', '  return nil', '}', 'func helper() {}', 'const Limit = 5'].join('\n')), ['1 struct Server', '4 method Server.Start', '7 function helper (private)', '8 constant Limit'])
    assert.deepEqual(shown('a.c', ['#define MAX 10', 'static int count(const char *s);', 'struct node *make_node(int v)', '{', '  return 0;', '}', 'static int count(const char *s) {', '  if (s) { return 1; }', '}', 'typedef struct node node_t;'].join('\n')), ['1 macro MAX', '3 function make_node', '7 function count', '10 type node_t'])
    assert.deepEqual(shown('a.hpp', ['namespace app {', 'class Router : public Base', '{', 'public:', '  explicit Router(int x);', '  void handle(Request& r) const;', '};', '}', 'void app::Router::handle(Request& r) const {}'].join('\n')), ['2 class Router', '5 method Router.Router', '6 method Router.handle', '9 function app::Router.handle'])
    assert.deepEqual(shown('A.java', ['package a;', '@Service', 'public class Users {', '  @Override', '  public List<User> findAll(int limit) {', '    return null;', '  }', '  private void check() {}', '}'].join('\n')), ['3 class Users', '5 method Users.findAll', '8 method Users.check (private)'])
    assert.deepEqual(shown('A.cs', ['namespace App.Core', '{', '  public sealed class Store', '  {', '    public async Task<int> CountAsync(string key) { return 1; }', '  }', '}'].join('\n')), ['3 class Store', '5 method Store.CountAsync'])
    assert.deepEqual(shown('a.kt', ['data class User(val id: Int)', 'fun main() {}', 'class Repo {', '  suspend fun load(): User = TODO()', '}'].join('\n')), ['1 class User', '2 function main', '3 class Repo', '4 method Repo.load'])
    assert.deepEqual(shown('a.php', ['<?php', 'class Cart {', '  public function total(): int { return 0; }', '}', 'function helper() {}'].join('\n')), ['2 class Cart', '3 method Cart.total', '5 function helper'])
    assert.deepEqual(shown('a.rb', ['module Shop', '  class Cart', '    def total', '    end', '  end', 'end'].join('\n')), ['1 class Shop', '2 class Shop.Cart', '3 method Cart.total'])
    assert.deepEqual(shown('run.sh', ['build() {', '  echo "deploy() {"', '}', 'function deploy {', '}'].join('\n')), ['1 function build', '4 function deploy'])
    assert.deepEqual(shown('schema.sql', ['CREATE TABLE IF NOT EXISTS `players` (', '  id INT', ');', '-- CREATE TABLE old (', 'create or replace view active_players as select 1;'].join('\n')), ['1 table players', '5 table active_players'])
  })

  it('never shows a value shaped like a secret, nor what a constant holds', () => {
    const text = ["export const API_KEY = 'sk-or-v1-abcdef1234567890abcdef'", "export function connect(url = 'postgres://admin:hunter2@db/app') {}", "export function sign(token = 'ghp_abcdefghijklmnop1234') {}", 'API_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7"'].join('\n')
    assert.deepEqual(extract('a.ts', text)!.definitions.map((definition) => definition.text), ['export const API_KEY', "export function connect(url = 'postgres://admin:…@db/app')", "export function sign(token = '…')"])
    assert.deepEqual(extract('a.py', 'API_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7"\n')!.definitions.map((definition) => definition.text), ['API_SECRET'])
    // Spaces before it do not move a secret past the part searched; past the part read it is not shown at all.
    assert.deepEqual(extract('b.ts', `export function sign(${' '.repeat(2_000)}token = 'ghp_abcdefghijklmnop1234') {}`)!.definitions.map((definition) => definition.text), ["export function sign( token = '…')"])
    assert.deepEqual(extract('b.ts', `export function sign(${' '.repeat(5_000)}token = 'ghp_abcdefghijklmnop1234') {}`)!.definitions.map((definition) => definition.text), ['export function sign('])
  })

  it('reads a line of hundreds of thousands of characters in about the time it takes to read it', () => {
    // Found by fuzzing: the secret search on letters with no digit, and Lua's signature on `function` with no `(`, took
    // seconds, and grow with the square of the line; C's function rules on a run of `*` or `&` grew with its cube.
    const started = performance.now()
    const letters = extract('a.ts', `export function big(x = "${'abcdefghij'.repeat(30_000)}") {}\nexport function next() {}\n`)!
    const lua = extract('a.lua', `function f(${'function '.repeat(30_000)}\n`)!
    const c = extract('a.c', `${'*'.repeat(100_000)}\n${'&'.repeat(100_000)}\nint a${'*'.repeat(100_000)}(;\n${'static '.repeat(20_000)}\nint tail(void) {}\n`)!
    assert.ok(performance.now() - started < 1_500, `${Math.round(performance.now() - started)} ms`)
    assert.deepEqual(letters.definitions.map((definition) => definition.name), ['big', 'next'])
    assert.ok(letters.definitions[0].text.length <= 110)
    assert.deepEqual(lua.definitions.map((definition) => definition.name), ['f'])
    assert.deepEqual(c.definitions.map((definition) => definition.name), ['tail'])
  })

  it("reads C's declarations behind export macros, and not a constructor's list of members", () => {
    assert.deepEqual(
      shown('a.h', ['ZEND_API void ZEND_FASTCALL zend_hash_clean(HashTable *ht);', 'PHPAPI zend_string *php_escape_shell_cmd(const char *str);', 'extern _X_EXPORT int GetDefaultPointSize ( void );', 'std::map<std::string, std::vector<int*>> &index_of(const char **names)', '{', '}'].join('\n')),
      ['1 function zend_hash_clean', '2 function php_escape_shell_cmd', '3 function GetDefaultPointSize', '4 function index_of'],
    )
    assert.deepEqual(shown('a.cpp', ['class Heap {', 'public:', '  template <class U> void destroy(U* p) { p->~U(); }', '  Heap(int size)', '    : base_type(size), m_size(0)', '  {}', '  virtual ~Heap();', '};'].join('\n')), ['1 class Heap', '3 method Heap.destroy', '4 method Heap.Heap', '7 method Heap.~Heap'])
  })

  it('reads Svelte and Vue from their scripts only', () => {
    assert.deepEqual(shown('App.svelte', ['<script lang="ts">', '  export function open() {}', '</script>', '<p>function nothere() {}</p>'].join('\n')), ['2 function open'])
    assert.deepEqual(shown('App.vue', ['<script>', 'export function open() {}', '</script>'].join('\n')), ['2 function open'])
  })

  it('knows a file by its extension, and reads none it does not know', () => {
    assert.equal(languageOf('src/a.TSX'), 'typescript')
    assert.equal(languageOf('fxmanifest.lua'), 'lua')
    assert.equal(languageOf('README.md'), undefined)
    assert.equal(extract('notes.txt', 'function a() {}'), undefined)
  })
})
