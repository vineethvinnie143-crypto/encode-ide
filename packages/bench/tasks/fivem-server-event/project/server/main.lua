RegisterNetEvent('shop:buy', function(item, amount, price)
  local src = source
  local cost = price * amount
  if Bridge.GetMoney(src) < cost then
    TriggerClientEvent('shop:result', src, false, 'Not enough money')
    return
  end
  Bridge.RemoveMoney(src, cost)
  Bridge.AddItem(src, item, amount)
  TriggerClientEvent('shop:result', src, true)
end)
