-- The shop menu: the player picks an item and an amount, and the server is asked to sell it.
RegisterCommand('shop', function()
  local item, amount = 'bread', 1
  TriggerServerEvent('shop:buy', item, amount, Config.Items[item].price)
end, false)

RegisterNetEvent('shop:result', function(ok, message)
  if not ok then print(('Could not buy: %s'):format(message)) end
end)
