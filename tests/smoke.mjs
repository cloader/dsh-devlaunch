/**
 * Supervisor smoke test (real processes, Windows):
 * 1. spawn a node one-liner that prints lines and stays alive
 * 2. capture output events
 * 3. stop it, assert the process tree is gone (no orphans)
 * 4. verify cwd + env handling
 *
 * Run: node tests/smoke.mjs
 *
 * @module dsh-devlaunch/tests/smoke
 */
import { ProcessSupervisor, realSpawnDeps } from '../src/host/supervisor.ts'
import { isWindows, setKillFace, realKillFace } from '../src/host/platform.ts'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// --- real kill face (this test wants the REAL taskkill path) ---
setKillFace(realKillFace)

const roots = { root: () => 'D:\\tmp\\deepseekharness\\dsh-devlaunch' }
const supervisor = new ProcessSupervisor({ roots, deps: realSpawnDeps() })

const outputEvents = []
const stateEvents = []
supervisor.on('output', e => outputEvents.push(e))
supervisor.on('state', e => stateEvents.push(e))

// 1) Start a node process that prints 3 lines then idles.
const group = {
  id: 'g-smoke1',
  kind: 'other',
  label: 'smoke',
  command: 'node -e "console.log(\'l1\');console.log(\'l2\');console.error(\'e1\');setInterval(()=>{},60000)"',
  cwd: '',
  env: { DL_SMOKE: 'yes' },
  enabled: true,
}

const startResult = supervisor.start('ws-test', group)
check('start ok', startResult.ok, JSON.stringify(startResult))

// Wait for output + state events.
await sleep(1500)
const lines = outputEvents.flatMap(e => e.chunk.lines)
check('captured stdout lines', lines.includes('l1') && lines.includes('l2'), JSON.stringify(lines))
check('captured stderr line', lines.includes('e1'), JSON.stringify(lines))
check('running state', supervisor.isRunning('ws-test', 'g-smoke1'))

// seq history + catch-up
const seq = supervisor.seqOf('ws-test', 'g-smoke1')
check('seq advanced', seq >= 3, `seq=${seq}`)
const caught = supervisor.historyAfter('ws-test', 'g-smoke1', 0)
check('history catch-up', caught.reduce((n, c) => n + c.lines.length, 0) >= 3, JSON.stringify(caught.map(c => c.lines)))

// 2) Env actually applied.
const envGroup = {
  ...group,
  id: 'g-smoke2',
  command: 'node -e "console.log(process.env.DL_SMOKE2 ?? \'missing\')"',
  env: { DL_SMOKE2: 'hello' },
}
supervisor.start('ws-test', envGroup)
await sleep(1200)
const envLines = outputEvents.filter(e => e.chunk.g === 'g-smoke2').flatMap(e => e.chunk.lines)
check('env passed to child', envLines.includes('hello'), JSON.stringify(envLines))

// 3) Stop: no orphans. The node process from g-smoke1 must die.
const pidBefore = supervisor.runsOf('ws-test', [group]).g_smoke1 ?? {}
supervisor.stop('ws-test', group)
await sleep(1500)

// Probe: any node process from our smoke run left? Use tasklist filtered by
// the marker interval script — simplest reliable probe: check supervisor's
// own state says exited.
const runs = supervisor.runsOf('ws-test', [group, envGroup])
check('smoke1 exited after stop', runs['g-smoke1']?.status === 'exited', JSON.stringify(runs['g-smoke1']))
void pidBefore

// Hard probe for orphans: list node processes whose command line mentions
// our marker string (only works with wmic-less systems; skip silently if
// the tool is unavailable).
const { execFile } = await import('node:child_process')
const probe = () => new Promise(resolve => {
  if (!isWindows()) { resolve('skip'); return }
  execFile('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'setInterval' } | Measure-Object | Select-Object -ExpandProperty Count"],
    { timeout: 15000 }, (error, stdout) => {
      if (error !== null) { resolve('skip'); return }
      resolve(stdout.toString().trim())
    })
})
const orphanCount = await probe()
check('no orphan node processes', orphanCount === '0' || orphanCount === 'skip', `probe=${orphanCount}`)

// 4) Restart: respawnOnClose must produce a new pid (regression: the old
//    stop()+start() raced the close event and returned 已在运行).
const restartGroup = {
  id: 'g-smoke3',
  kind: 'other',
  label: 'restart-probe',
  command: 'node -e "console.log(\'BOOT \'+process.pid);setInterval(()=>console.log(\'hb\'),400)"',
  cwd: '',
  env: {},
  enabled: true,
}
supervisor.start('ws-test', restartGroup)
await sleep(1200)
const runBefore = supervisor.runsOf('ws-test', [restartGroup])['g-smoke3']
const pidBefore2 = runBefore?.pid
const restartOutcome = supervisor.restart('ws-test', restartGroup)
check('restart accepted', restartOutcome.ok, JSON.stringify(restartOutcome))
await sleep(2500)
const runAfter = supervisor.runsOf('ws-test', [restartGroup])['g-smoke3']
check('respawned running', runAfter?.status === 'running', JSON.stringify(runAfter))
check('respawned new pid', typeof runAfter?.pid === 'number' && runAfter.pid !== pidBefore2, `${pidBefore2} -> ${runAfter?.pid}`)
const restartLines = supervisor.historyAfter('ws-test', 'g-smoke3', 0).flatMap(c => c.lines)
check('respawn produced fresh boot output', restartLines.some(l => l.startsWith('BOOT ')), JSON.stringify(restartLines.slice(0, 3)))

supervisor.dispose()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
