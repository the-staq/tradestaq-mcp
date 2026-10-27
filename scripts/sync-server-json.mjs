// `npm version` lifecycle: keeps the MCP Registry metadata (server.json) on the version being
// released, both the server's own and its npm package's. It sat at 0.4.0 while npm moved on.
import fs from 'node:fs'

const version = process.env.npm_package_version
const pkgName = process.env.npm_package_name
const file = new URL('../server.json', import.meta.url)

if (!version || !pkgName) {
  console.error('sync-server-json: run through `npm version` (npm_package_version/name are not set)')
  process.exit(1)
}
const server = JSON.parse(fs.readFileSync(file, 'utf8'))
const npmPackages = (server.packages ?? []).filter((p) => p.registryType === 'npm' && p.identifier === pkgName)
if (!npmPackages.length) {
  console.error(`sync-server-json: server.json lists no npm package "${pkgName}"`)
  process.exit(1)
}
server.version = version
for (const p of npmPackages) p.version = version
fs.writeFileSync(file, JSON.stringify(server, null, 2) + '\n')
