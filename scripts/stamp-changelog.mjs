// `npm version` lifecycle: files the [Unreleased] notes under the new version's heading,
// so a release can no longer leave its notes sitting under [Unreleased] (0.6.0 and 0.6.1 did).
import fs from 'node:fs'

const version = process.env.npm_package_version
const file = new URL('../CHANGELOG.md', import.meta.url)
const text = fs.readFileSync(file, 'utf8')
const marker = '## [Unreleased]\n'

if (!version) {
  console.error('stamp-changelog: run through `npm version` (npm_package_version is not set)')
  process.exit(1)
}
if (!text.includes(marker)) {
  console.error('stamp-changelog: CHANGELOG.md has no "## [Unreleased]" heading')
  process.exit(1)
}
if (!text.includes(`## [${version}]`)) {
  const date = new Date().toISOString().slice(0, 10)
  fs.writeFileSync(file, text.replace(marker, `${marker}\n## [${version}] - ${date}\n`))
}
