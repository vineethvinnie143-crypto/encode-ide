---@meta _
-- FiveM's Lua runtime for lua-language-server: what a resource's scripts have besides the natives. Written by eNCode
-- from how the runtime behaves; written again when eNCode changes it.

---@class vector2
---@field x number
---@field y number
---@field xy vector2
---@field yx vector2
---@operator add(vector2|number): vector2
---@operator sub(vector2|number): vector2
---@operator mul(vector2|number): vector2
---@operator div(vector2|number): vector2
---@operator unm: vector2
---@operator len: number

---@class vector3
---@field x number
---@field y number
---@field z number
---@field xy vector2
---@field xz vector2
---@field yz vector2
---@field xyz vector3
---@operator add(vector3|number): vector3
---@operator sub(vector3|number): vector3
---@operator mul(vector3|number): vector3
---@operator div(vector3|number): vector3
---@operator unm: vector3
---@operator len: number

---@class vector4
---@field x number
---@field y number
---@field z number
---@field w number
---@field xy vector2
---@field xyz vector3
---@field xyzw vector4
---@operator add(vector4|number): vector4
---@operator sub(vector4|number): vector4
---@operator mul(vector4|number): vector4
---@operator div(vector4|number): vector4
---@operator unm: vector4
---@operator len: number

---@class quat
---@field x number
---@field y number
---@field z number
---@field w number
---@operator mul(quat): quat
---@operator mul(vector3): vector3
---@operator unm: quat
---@operator len: number

---A 2D vector: `#v` is its length, and it adds, subtracts, multiplies and divides by a vector or a number.
---@param x number
---@param y? number when left out, both are `x`
---@return vector2
function vector2(x, y) end

---A 3D vector, as positions and rotations come back from the natives: `v.xy`, `#v` (its length), `v + w`, `v * 2.0`.
---@param x number
---@param y? number
---@param z? number when `y` and `z` are left out, all three are `x`
---@return vector3
function vector3(x, y, z) end

---A 4D vector: a position and a heading, as many scripts keep them.
---@param x number
---@param y? number
---@param z? number
---@param w? number
---@return vector4
function vector4(x, y, z, w) end

---A vector of as many parts as it is given (one to four).
---@overload fun(x: number, y: number): vector2
---@overload fun(x: number, y: number, z: number, w: number): vector4
---@param x number
---@param y number
---@param z number
---@return vector3
function vec(x, y, z) end

---@param x number
---@param y? number
---@return vector2
function vec2(x, y) end

---@param x number
---@param y? number
---@param z? number
---@return vector3
function vec3(x, y, z) end

---@param x number
---@param y? number
---@param z? number
---@param w? number
---@return vector4
function vec4(x, y, z, w) end

---A rotation as a quaternion.
---@overload fun(angle: number, axis: vector3): quat
---@param w number
---@param x number
---@param y number
---@param z number
---@return quat
function quat(w, x, y, z) end

---The vector made one long, in the same direction.
---@generic V: vector2|vector3|vector4|quat
---@param value V
---@return V
function norm(value) end

---@class CitizenModule
Citizen = {}

---Runs `fn` as a thread of its own, from the next frame: it may `Wait`.
---@param fn async fun()
function Citizen.CreateThread(fn) end

---Runs `fn` as a thread of its own now, until its first `Wait`.
---@param fn async fun()
function Citizen.CreateThreadNow(fn) end

---Waits so many milliseconds (0 is the next frame). Only inside a thread or an event handler.
---@async
---@param ms integer
function Citizen.Wait(ms) end

---Calls `fn` once, after so many milliseconds.
---@param ms integer
---@param fn async fun()
---@return integer id for `ClearTimeout`
function Citizen.SetTimeout(ms, fn) end

---Cancels a call `SetTimeout` planned.
---@param id integer
function Citizen.ClearTimeout(id) end

---Waits for a promise and gives back its value; an error when it is rejected.
---@async
---@param p promise
---@return any
function Citizen.Await(p) end

---Writes to the console, as `print` does without a new line.
---@param text string
function Citizen.Trace(text) end

---Calls a native by its hash. The natives have their own names, with their types: prefer those.
---@param hash integer|string
---@param ... any
---@return any
function Citizen.InvokeNative(hash, ...) end

---@return any
function Citizen.ResultAsInteger() end
---@return any
function Citizen.ResultAsFloat() end
---@return any
function Citizen.ResultAsString() end
---@return any
function Citizen.ResultAsVector() end
---@return any
function Citizen.ResultAsLong() end
---@return any
function Citizen.ResultAsObject() end
---@return any
function Citizen.PointerValueInt() end
---@return any
function Citizen.PointerValueFloat() end
---@return any
function Citizen.PointerValueVector() end
---@param value integer
---@return any
function Citizen.PointerValueIntInitialized(value) end
---@param value number
---@return any
function Citizen.PointerValueFloatInitialized(value) end
---@return any
function Citizen.ReturnResultAnyway() end

---@param fn function
---@return string
function Citizen.GetFunctionReference(fn) end

---Runs `fn` as a thread of its own, from the next frame: it may `Wait`.
---@param fn async fun()
function CreateThread(fn) end

---Waits so many milliseconds (0 is the next frame). Only inside a thread or an event handler.
---@async
---@param ms integer
function Wait(ms) end

---Calls `fn` once, after so many milliseconds.
---@param ms integer
---@param fn async fun()
---@return integer id for `ClearTimeout`
function SetTimeout(ms, fn) end

---Cancels a call `SetTimeout` planned.
---@param id integer
function ClearTimeout(id) end

---@class EventHandlerData
---@field key integer
---@field name string

---Calls `fn` for each event of that name: one this resource or another triggers, and one from the network when it was
---also registered with `RegisterNetEvent`. In a server's handler of a client's event, `source` is the player.
---@param name string
---@param fn async fun(...: any)
---@return EventHandlerData
function AddEventHandler(name, fn) end

---Stops a handler `AddEventHandler` added.
---@param data EventHandlerData
function RemoveEventHandler(data) end

---Lets the event come from the network (from the server, or on the server from players), and adds `fn` for it.
---Anything in an event from a player can be forged: check it on the server.
---@param name string
---@param fn? async fun(...: any)
---@return EventHandlerData?
function RegisterNetEvent(name, fn) end

---@deprecated Use RegisterNetEvent.
---@param name string
---@param fn? async fun(...: any)
function RegisterServerEvent(name, fn) end

---Triggers an event in this script's side (client or server), for every resource's handlers.
---@param name string
---@param ... any
function TriggerEvent(name, ...) end

---Client only: sends an event to the server. The server cannot trust what is in it.
---@param name string
---@param ... any
function TriggerServerEvent(name, ...) end

---Client only: sends a large event to the server a little at a time.
---@param name string
---@param bytesPerSecond integer
---@param ... any
function TriggerLatentServerEvent(name, bytesPerSecond, ...) end

---Server only: sends an event to a player, or to every player with -1.
---@param name string
---@param target integer|string the player's server id, or -1 for everyone
---@param ... any
function TriggerClientEvent(name, target, ...) end

---Server only: sends a large event to a player a little at a time.
---@param name string
---@param target integer|string
---@param bytesPerSecond integer
---@param ... any
function TriggerLatentClientEvent(name, target, bytesPerSecond, ...) end

---In a handler of an event from the network: on the server, the server id of the player who sent it (a string in
---some events: compare with `tonumber`); on a client, the server's.
---@type integer
source = nil

---Client only: answers a `fetch` from the resource's page (NUI). Call `cb` with what the page gets back.
---@param name string
---@param fn fun(data: any, cb: fun(result: any))
function RegisterNUICallback(name, fn) end

---Client only: sends a message to the resource's page (NUI), where `window.addEventListener('message', ...)` gets it.
---@param message table
function SendNUIMessage(message) end

---@class StateBag
---@field [string] any
local StateBag = {}

---Sets a key; with `replicated`, the other side sees it too. A client may set only what the server lets it.
---@param key string
---@param value any
---@param replicated boolean
function StateBag:set(key, value, replicated) end

---@class StateBagOwner
---@field state StateBag

---Values the server keeps for everyone (`GlobalState.key`). Only the server sets them.
---@type StateBag
GlobalState = nil

---Client only: this player's own state.
---@type StateBagOwner
LocalPlayer = nil

---A player's state, by server id.
---@param serverId integer|string
---@return StateBagOwner
function Player(serverId) end

---An entity's state, by its handle (on the server, or a networked entity on a client).
---@param handle integer
---@return StateBagOwner
function Entity(handle) end

---What other resources export, by resource: `exports.ox_inventory:Search(...)` or `exports['qb-core']:GetCoreObject()`.
---Called as `exports('Name', fn)`, makes a function of this resource one others may call.
---@class CfxExports
---@field [string] table<string, fun(self: any, ...: any): any>
---@overload fun(name: string, fn: function)
exports = {}

---@class promise
promise = {}

---A new promise, for `Citizen.Await`.
---@return promise
function promise.new() end

---@param value? any
function promise:resolve(value) end

---@param reason? any
function promise:reject(reason) end

---@param onFulfilled? fun(value: any): any
---@param onRejected? fun(reason: any): any
---@return promise
function promise:next(onFulfilled, onRejected) end

---@class jsonlib
json = {}

---@param value any
---@param options? { indent?: boolean, sort_keys?: boolean, keyorder?: string[] }
---@return string
function json.encode(value, options) end

---@param text string
---@return any
function json.decode(text) end

---The value that stands for JSON's null.
json.null = nil

---@class msgpacklib
msgpack = {}

---@param ... any
---@return string
function msgpack.pack(...) end

---@param data string
---@return any ...
function msgpack.unpack(data) end
