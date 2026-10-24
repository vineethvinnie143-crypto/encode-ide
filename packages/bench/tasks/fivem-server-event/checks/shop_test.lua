-- Plays the shop's buy event the way FiveM would, with a client that sends what it likes.
local root = assert(os.getenv('BENCH_ROOT'), 'BENCH_ROOT is not set')
local handlers = {}
function RegisterNetEvent(name, handler)
  if handler then handlers[name] = handler end
end
function AddEventHandler(name, handler) handlers[name] = handler end
local results = {}
function TriggerClientEvent(name, target, ...) results[#results + 1] = { name = name, target = target, args = { ... } } end
function GetPlayerName() return 'player' end
function print() end

local money, items = {}, {}
Bridge = {
  GetMoney = function(src) return money[src] end,
  RemoveMoney = function(src, amount) money[src] = money[src] - amount end,
  AddItem = function(src, item, amount)
    items[src] = items[src] or {}
    items[src][item] = (items[src][item] or 0) + amount
  end,
}

dofile(root .. '/config.lua')
dofile(root .. '/server/main.lua')
local buy = assert(handlers['shop:buy'], 'no handler for shop:buy')

local failures = 0
local function case(name, src, start, args, wantMoney, wantItems)
  money[src], items[src], source = start, nil, src
  local ok, problem = pcall(buy, table.unpack(args, 1, args.n))
  local got = items[src]
  local same = (wantItems == nil and got == nil) or (wantItems ~= nil and got ~= nil and got[wantItems[1]] == wantItems[2])
  if not ok or money[src] ~= wantMoney or not same then
    failures = failures + 1
    io.stderr:write(('FAIL %s: %s, money %s, items %s\n'):format(name, ok and 'ran' or ('error: ' .. tostring(problem)), tostring(money[src]), got and next(got) and (next(got) .. ' ' .. got[next(got)]) or 'none'))
  end
end

case('charges the server price, not the one sent', 1, 100, { 'bread', 2, 0, n = 3 }, 90, { 'bread', 2 })
case('a price sent higher changes nothing either', 2, 100, { 'water', 3, 1000, n = 3 }, 91, { 'water', 3 })
case('not enough money at the real price', 3, 100, { 'lockpick', 1, 1, n = 3 }, 100, nil)
case('an item that is not sold', 4, 1000, { 'gold', 1, 1, n = 3 }, 1000, nil)
case('a negative amount', 5, 1000, { 'water', -5, 3, n = 3 }, 1000, nil)
case('a zero amount', 6, 1000, { 'water', 0, 3, n = 3 }, 1000, nil)
case('a fraction', 7, 1000, { 'water', 1.5, 3, n = 3 }, 1000, nil)
case('more than the most allowed', 8, 1000, { 'water', 21, 3, n = 3 }, 1000, nil)
case('an amount that is not a number', 9, 1000, { 'water', '2', 3, n = 3 }, 1000, nil)
case('an item that is not a string', 10, 1000, { { 'bread' }, 1, 5, n = 3 }, 1000, nil)
case('the most allowed', 11, 1000, { 'water', 20, 0, n = 3 }, 940, { 'water', 20 })

if failures > 0 then
  io.stderr:write(('%d of 11 cases failed\n'):format(failures))
  os.exit(1)
end
print('all 11 cases passed')
