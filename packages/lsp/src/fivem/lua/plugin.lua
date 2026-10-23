-- eNCode's plugin for lua-language-server (ADR 0084): CfxLua, the Lua FiveM runs, read as plain Lua. It looks at a
-- file's text and says how to read each addition; it runs nothing, loads nothing and touches no file.
--
--   `name`            the hash CfxLua makes of it, as a number
--   a?.b a?[k] a?:m() as a.b, a[k], a:m()
--   local a, b in t   as local a, b = (t).a, (t).b
--   { .a, .b }        as { a = true, b = true }
--   fxmanifest.lua    its directives, known and taken as given

local byte, sub, lower = string.byte, string.sub, string.lower

local B_TICK, B_QUOTE, B_DQUOTE, B_BSLASH = 96, 39, 34, 92
local B_DASH, B_SLASH, B_STAR, B_LBRACK, B_RBRACK, B_EQ = 45, 47, 42, 91, 93, 61
local B_LBRACE, B_RBRACE, B_LPAREN, B_RPAREN, B_COMMA, B_SEMI = 123, 125, 40, 41, 44, 59
local B_DOT, B_COLON, B_QMARK, B_NL, B_LT, B_GT = 46, 58, 63, 10, 60, 62

local function isNameStart(c)
    return c and (c == 95 or (c >= 65 and c <= 90) or (c >= 97 and c <= 122))
end

local function isName(c)
    return c and (isNameStart(c) or (c >= 48 and c <= 57))
end

local function isSpace(c)
    return c == 32 or c == 9 or c == 10 or c == 13 or c == 11 or c == 12
end

local KEYWORDS = {}
for word in ('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'):gmatch('%a+') do
    KEYWORDS[word] = true
end

-- The hash GetHashKey gives (Jenkins' one-at-a-time over the lower-cased text), as the signed number CfxLua makes.
local function joaat(text)
    local hash = 0
    text = lower(text)
    for i = 1, #text do
        hash = (hash + byte(text, i)) & 0xFFFFFFFF
        hash = (hash + (hash << 10)) & 0xFFFFFFFF
        hash = hash ~ (hash >> 6)
    end
    hash = (hash + (hash << 3)) & 0xFFFFFFFF
    hash = hash ~ (hash >> 11)
    hash = (hash + (hash << 15)) & 0xFFFFFFFF
    if hash >= 0x80000000 then
        hash = hash - 0x100000000
    end
    return hash
end

-- `[[`, `[==[`: the number of `=` signs, or nil when `i` starts no long bracket.
local function longOpen(text, i)
    if byte(text, i) ~= B_LBRACK then
        return nil
    end
    local j = i + 1
    while byte(text, j) == B_EQ do
        j = j + 1
    end
    if byte(text, j) == B_LBRACK then
        return j - i - 1
    end
    return nil
end

-- Past the long bracket of `level` that opens at `i`, or past the end of the text when it is not closed.
local function skipLong(text, i, level)
    local close = ']' .. string.rep('=', level) .. ']'
    local _, finish = text:find(close, i + level + 2, true)
    return finish and finish + 1 or #text + 1
end

-- Past the string that opens at `i` with `quote`; a string is not closed by a new line.
local function skipQuoted(text, i, quote)
    local j = i + 1
    local n = #text
    while j <= n do
        local c = byte(text, j)
        if c == B_BSLASH then
            j = j + 2
        elseif c == quote then
            return j + 1
        elseif c == B_NL then
            return j
        else
            j = j + 1
        end
    end
    return j
end

-- When `i` starts a comment or a string: where it ends. Otherwise nil.
local function skipNonCode(text, i)
    local c = byte(text, i)
    if c == B_DASH and byte(text, i + 1) == B_DASH then
        local level = longOpen(text, i + 2)
        if level then
            return skipLong(text, i + 2, level)
        end
        local finish = text:find('\n', i + 2, true)
        return finish or #text + 1
    end
    if c == B_SLASH and byte(text, i + 1) == B_STAR then
        local _, finish = text:find('*/', i + 2, true)
        return finish and finish + 1 or #text + 1
    end
    if c == B_QUOTE or c == B_DQUOTE then
        return skipQuoted(text, i, c)
    end
    if c == B_LBRACK then
        local level = longOpen(text, i)
        if level then
            return skipLong(text, i, level)
        end
    end
    return nil
end

local function skipSpace(text, i)
    while isSpace(byte(text, i)) do
        i = i + 1
    end
    return i
end

local function readName(text, i)
    if not isNameStart(byte(text, i)) then
        return nil
    end
    local j = i
    while isName(byte(text, j)) do
        j = j + 1
    end
    return sub(text, i, j - 1), j
end

-- Past the bracket that opens at `i` and its match, skipping strings and comments; nil when it is not closed, or
-- holds something this plugin changes (a hash, `?.`), which a copy of the text would not carry.
local function skipBalanced(text, i)
    local depth = 0
    local n = #text
    local j = i
    while j <= n do
        local past = skipNonCode(text, j)
        if past then
            j = past
        else
            local c = byte(text, j)
            if c == B_LPAREN or c == B_LBRACK or c == B_LBRACE then
                depth = depth + 1
            elseif c == B_RPAREN or c == B_RBRACK or c == B_RBRACE then
                depth = depth - 1
                if depth == 0 then
                    return j + 1
                end
            elseif c == B_TICK or c == B_QMARK then
                return nil
            end
            j = j + 1
        end
    end
    return nil
end

-- The end (exclusive) of the expression a `local ... in` takes, when it is a name, a field, an index or a call
-- of them; nil for anything else, which is then left as it is.
local function prefixExpression(text, i)
    local j
    local name, after = readName(text, i)
    if name then
        if KEYWORDS[name] then
            return nil
        end
        j = after
    elseif byte(text, i) == B_LPAREN then
        j = skipBalanced(text, i)
        if not j then
            return nil
        end
    else
        return nil
    end
    while true do
        local k = skipSpace(text, j)
        local c = byte(text, k)
        if c == B_DOT and byte(text, k + 1) ~= B_DOT then
            local field, past = readName(text, skipSpace(text, k + 1))
            if not field then
                return j
            end
            j = past
        elseif c == B_LBRACK and not longOpen(text, k) then
            local past = skipBalanced(text, k)
            if not past then
                return nil
            end
            j = past
        elseif c == B_LPAREN then
            local past = skipBalanced(text, k)
            if not past then
                return nil
            end
            j = past
        elseif c == B_COLON and byte(text, k + 1) ~= B_COLON then
            local method, past = readName(text, skipSpace(text, k + 1))
            if not method then
                return j
            end
            local open = skipSpace(text, past)
            local d = byte(text, open)
            local closed
            if d == B_LPAREN or d == B_LBRACE then
                closed = skipBalanced(text, open)
            elseif d == B_QUOTE or d == B_DQUOTE then
                closed = skipQuoted(text, open, d)
            end
            if not closed then
                return nil
            end
            j = closed
        elseif c == B_QUOTE or c == B_DQUOTE then
            j = skipQuoted(text, k, c)
        else
            return j
        end
    end
end

-- `local a, b <const> in`: the names, and where `in` starts, when `i` is just past `local`.
local function unpackNames(text, i)
    local names = {}
    local j = i
    while true do
        j = skipSpace(text, j)
        local name, past = readName(text, j)
        if not name or KEYWORDS[name] then
            return nil
        end
        names[#names + 1] = name
        j = skipSpace(text, past)
        if byte(text, j) == B_LT then
            local _, close = text:find('^%s*%a+%s*>', j + 1)
            if not close then
                return nil
            end
            j = skipSpace(text, close + 1)
        end
        if byte(text, j) ~= B_COMMA then
            break
        end
        j = j + 1
    end
    if sub(text, j, j + 1) == 'in' and not isName(byte(text, j + 2)) then
        return names, j
    end
    return nil
end

local MANIFEST_HEADER = table.concat({
    '---@diagnostic disable: undefined-global, lowercase-global, unused-local, unused-function, missing-return, redundant-parameter, redundant-return-value',
    '---@alias fx.list string|string[]',
    '---@alias fx.next fun(value?: fx.list|table): fx.next',
    '---The version of the manifest format: \'cerulean\' for every resource made today.',
    '---@param version \'cerulean\'|\'bodacious\'|\'adamant\'',
    'local function fx_version(version) end',
    '---The game the resource is for.',
    '---@param name \'gta5\'|\'rdr3\'|\'common\'',
    'local function game(name) end',
    '---The games the resource is for.',
    '---@param names (\'gta5\'|\'rdr3\'|\'common\')[]',
    'local function games(names) end',
    '---@param value string',
    'local function author(value) end',
    '---@param value string',
    'local function description(value) end',
    '---@param value string',
    'local function version(value) end',
    '---Runs the resource\'s scripts on Lua 5.4. Write \'yes\'.',
    '---@param value \'yes\'',
    'local function lua54(value) end',
    '---A script that runs on the player\'s game. A glob, such as \'client/*.lua\', or \'@resource/file.lua\' from another resource.',
    '---@param path fx.list',
    'local function client_script(path) end',
    '---Scripts that run on the player\'s game.',
    '---@param paths fx.list',
    'local function client_scripts(paths) end',
    '---A script that runs on the server.',
    '---@param path fx.list',
    'local function server_script(path) end',
    '---Scripts that run on the server.',
    '---@param paths fx.list',
    'local function server_scripts(paths) end',
    '---A script that runs on both the server and the player\'s game.',
    '---@param path fx.list',
    'local function shared_script(path) end',
    '---Scripts that run on both the server and the player\'s game.',
    '---@param paths fx.list',
    'local function shared_scripts(paths) end',
    '---A file the player\'s game downloads: a page\'s files, a data file, a stream.',
    '---@param path fx.list',
    'local function file(path) end',
    '---Files the player\'s game downloads.',
    '---@param paths fx.list',
    'local function files(paths) end',
    '---The page the resource shows in the game (NUI), one of its files.',
    '---@param page string',
    '---@return fx.next',
    'local function ui_page(page) end',
    '---A resource that must be started before this one.',
    '---@param name string',
    'local function dependency(name) end',
    '---Resources that must be started before this one, and what the server must have (\'/server:5848\', \'/onesync\').',
    '---@param names string[]',
    'local function dependencies(names) end',
    '---Another resource\'s name this one answers to.',
    '---@param name string',
    'local function provide(name) end',
    '---A function of a client script other resources may call.',
    '---@param name string',
    'local function export(name) end',
    '---Functions of client scripts other resources may call.',
    '---@param names string[]',
    'local function exports(names) end',
    '---A function of a server script other resources may call.',
    '---@param name string',
    'local function server_export(name) end',
    '---Functions of server scripts other resources may call.',
    '---@param names string[]',
    'local function server_exports(names) end',
    '---A data file the game loads, by its kind, then its file: data_file \'DLC_ITYP_REQUEST\' \'stream/props.ytyp\'.',
    '---@param kind string',
    '---@return fun(file: string)',
    'local function data_file(kind) end',
    '---The map this resource is, for the map manager.',
    '---@param value \'yes\'',
    'local function this_is_a_map(value) end',
    '---The page shown while the game loads.',
    '---@param page string',
    'local function loadscreen(page) end',
    '---The loading screen stays until a script shuts it.',
    '---@param value \'yes\'',
    'local function loadscreen_manual_shutdown(value) end',
    '---The loading screen shows the mouse.',
    '---@param value \'yes\'',
    'local function loadscreen_cursor(value) end',
    '---@param path string',
    'local function before_level_meta(path) end',
    '---@param path string',
    'local function after_level_meta(path) end',
    '---@param path string',
    'local function replace_level_meta(path) end',
    '---@param value \'yes\'',
    'local function use_experimental_fxv2_oal(value) end',
    '---@param value \'yes\'',
    'local function clr_disable_task_scheduler(value) end',
    '---The Node.js a JavaScript resource runs on.',
    '---@param value string',
    'local function node_version(value) end',
    '---The resource runs on the server only, and players do not download it.',
    '---@param value \'yes\'',
    'local function server_only(value) end',
    '---Settings (convars) the server\'s console shows for the resource.',
    '---@param name string',
    '---@return fun(values: table)',
    'local function convar_category(name) end',
    '---RedM: the notice that this resource is for RedM.',
    '---@param value string',
    'local function rdr3_warning(value) end',
    '',
}, '\n')

local function isManifest(uri)
    local name = lower(uri:match('[^/\\]+$') or '')
    return name == 'fxmanifest.lua' or name == '__resource.lua'
end

-- What lua-language-server reads instead of the text: a list of changes, or nil when the text is plain Lua.
function OnSetText(uri, text)
    local diffs = {}
    if isManifest(uri) then
        diffs[#diffs + 1] = { start = 1, finish = 0, text = MANIFEST_HEADER }
    end
    if not text:find('[`?.]') and not text:find('local', 1, true) then
        return #diffs > 0 and diffs or nil
    end
    -- What each open bracket is, innermost last, and whether the next thing inside a `{` starts an element.
    local brackets = {}
    local elementStart = false
    local i = 1
    local n = #text
    while i <= n do
        local past = skipNonCode(text, i)
        if past then
            i = past
        else
            local c = byte(text, i)
            if isSpace(c) then
                i = i + 1
            elseif c == B_TICK then
                elementStart = false
                local close = text:find('[`\n]', i + 1)
                if close and byte(text, close) == B_TICK then
                    diffs[#diffs + 1] = { start = i, finish = close, text = tostring(joaat(sub(text, i + 1, close - 1))) }
                    i = close + 1
                else
                    i = i + 1
                end
            elseif c == B_QMARK then
                elementStart = false
                local d = byte(text, i + 1)
                if d == B_DOT or d == B_LBRACK or d == B_COLON then
                    diffs[#diffs + 1] = { start = i, finish = i, text = ' ' }
                end
                i = i + 1
            elseif c == B_DOT and elementStart and isNameStart(byte(text, i + 1)) then
                elementStart = false
                local name, after = readName(text, i + 1)
                diffs[#diffs + 1] = { start = i, finish = after - 1, text = name .. ' = true' }
                i = after
            elseif isNameStart(c) then
                elementStart = false
                local name, after = readName(text, i)
                -- `a.local` is a field, not the keyword.
                local before = i > 1 and byte(text, i - 1) or nil
                if name == 'local' and before ~= B_DOT and before ~= B_COLON then
                    local names, inAt = unpackNames(text, after)
                    if names then
                        local from = skipSpace(text, inAt + 2)
                        local finish = prefixExpression(text, from)
                        if finish then
                            local expression = sub(text, from, finish - 1)
                            local values = {}
                            for index, field in ipairs(names) do
                                values[index] = '(' .. expression .. ').' .. field
                            end
                            diffs[#diffs + 1] = { start = inAt, finish = finish - 1, text = '= ' .. table.concat(values, ', ') }
                            after = finish
                        end
                    end
                end
                i = after
            else
                if c == B_LBRACE or c == B_LPAREN or (c == B_LBRACK and not longOpen(text, i)) then
                    brackets[#brackets + 1] = c
                elseif c == B_RBRACE or c == B_RPAREN or c == B_RBRACK then
                    brackets[#brackets] = nil
                end
                elementStart = brackets[#brackets] == B_LBRACE and (c == B_LBRACE or c == B_COMMA or c == B_SEMI)
                -- A number such as 1.5 or a concatenation `..` is never an element's start.
                if c == B_DOT then
                    while byte(text, i + 1) == B_DOT do
                        i = i + 1
                    end
                elseif c >= 48 and c <= 57 then
                    while isName(byte(text, i + 1)) or byte(text, i + 1) == B_DOT do
                        i = i + 1
                    end
                end
                i = i + 1
            end
        end
    end
    return #diffs > 0 and diffs or nil
end
