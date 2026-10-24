-- The framework behind the shop. Swap these three for your framework's calls.
Bridge = {}

function Bridge.GetMoney(src)
  return exports.economy:getMoney(src)
end

function Bridge.RemoveMoney(src, amount)
  exports.economy:removeMoney(src, amount)
end

function Bridge.AddItem(src, item, amount)
  exports.inventory:addItem(src, item, amount)
end
