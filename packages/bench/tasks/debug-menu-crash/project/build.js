// Builds the site's menu from site.json and writes it to menu.txt.
import { readFileSync, writeFileSync } from 'node:fs'
import { buildMenu, renderMenu } from './src/menu.js'

const site = JSON.parse(readFileSync(new URL('./site.json', import.meta.url), 'utf8'))
const lines = renderMenu(buildMenu(site.pages))
writeFileSync(new URL('./menu.txt', import.meta.url), `${site.title}\n${lines.join('\n')}\n`)
console.log(`menu.txt: ${lines.length} entries`)
