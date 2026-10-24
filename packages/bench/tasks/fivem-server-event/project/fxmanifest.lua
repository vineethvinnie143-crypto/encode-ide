fx_version 'cerulean'
game 'gta5'
lua54 'yes'

name 'corner-shop'
version '1.2.0'

shared_script 'config.lua'
client_script 'client/main.lua'
server_scripts {
  'server/bridge.lua',
  'server/main.lua',
}
