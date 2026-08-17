/**
 * Scanner fixture test (real fs): a monorepo-shaped temp tree exercises the
 * package.json discovery — root manifest, nested workspace packages, skipped
 * node_modules / dot-dirs, and the depth cap.
 *
 * Run: node --experimental-strip-types tests/scan-fixture.mjs
 *
 * @module dsh-devlaunch/tests/scan-fixture
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { scanPackageScripts } from '../src/host/scanner.ts'

const root = resolve('tests/.scan-fixture')
let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

/** Write one manifest. */
function pkg(dir, name, scripts) {
  const abs = join(root, dir)
  mkdirSync(abs, { recursive: true })
  writeFileSync(join(abs, 'package.json'), JSON.stringify({ name, scripts }, null, 2))
}

// Build the fixture tree.
rmSync(root, { recursive: true, force: true })
pkg('', 'monorepo-root', { dev: 'vite', build: 'vite build' })
pkg('packages/web', 'web', { dev: 'vite', lint: 'eslint .' })
pkg('packages/api', 'api', { dev: 'node server.js' })
pkg('apps/deep/nested', 'deep', { dev: 'node deep.js' })        // depth 3 → included
pkg('apps/deep/nested/toolong', 'toolong', { dev: 'x' })        // depth 4 → excluded
pkg('node_modules/dep', 'dep', { dev: 'x' })                     // skipped by name
pkg('packages/web/.cache/tpl', 'tpl', { dev: 'x' })             // skipped dot-dir
pkg('dist', 'dist-pkg', { dev: 'x' })                            // skipped build dir

const rows = await scanPackageScripts(root)

const cwds = [...new Set(rows.map(r => r.cwd))]
check('root package included', cwds[0] === '', JSON.stringify(cwds))
check('packages/web included', cwds.includes('packages/web'), JSON.stringify(cwds))
check('packages/api included', cwds.includes('packages/api'), JSON.stringify(cwds))
check('depth-3 package included', cwds.includes('apps/deep/nested'), JSON.stringify(cwds))
check('depth-4 package excluded', !cwds.includes('apps/deep/nested/toolong'), JSON.stringify(cwds))
check('node_modules skipped', !cwds.some(c => c.includes('node_modules')), JSON.stringify(cwds))
check('dot-dirs skipped', !cwds.some(c => c.includes('.cache')), JSON.stringify(cwds))
check('dist skipped', !cwds.includes('dist'), JSON.stringify(cwds))

check('commands are npm run', rows.every(r => r.command === `npm run ${r.name}`))
check('pkg names resolved', rows.filter(r => r.cwd === 'packages/web')[0]?.pkg === 'web', JSON.stringify(rows.filter(r => r.cwd === 'packages/web')))
check('root-first ordering', rows[0]?.cwd === '', JSON.stringify(rows[0]))

// Same script name from two packages must both survive (client keys on cwd+name).
const devs = rows.filter(r => r.name === 'dev')
check('duplicate script names kept per package', devs.length === 4, JSON.stringify(devs.map(r => r.cwd)))

// Empty workspace (no manifests at all) → empty list, no throw.
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const empty = await scanPackageScripts(root)
check('empty tree → empty list', Array.isArray(empty) && empty.length === 0, JSON.stringify(empty))

rmSync(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
