/**
 * Feature tests for dsh-devlaunch 0.3.0 (real processes, Windows-safe):
 * - port extraction from process output
 * - auto-restart on abnormal exit (backoff, manual start resets)
 * - readiness probing via readyUrl (real HTTP server)
 * - protocol: launch profiles normalization + readyUrl validation
 *
 * Run: node --experimental-strip-types tests/features.mjs
 *
 * @module dsh-devlaunch/tests/features
 */
import { createServer } from 'node:http'
import { ProcessSupervisor, realSpawnDeps } from '../src/host/supervisor.ts'
import { normalizeGroup, normalizeWorkspaceConfig } from '../src/shared/protocol.ts'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

let failures = 0
function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const roots = { root: () => 'D:\\tmp\\deepseekharness\\dsh-devlaunch' }
const supervisor = new ProcessSupervisor({ roots, deps: realSpawnDeps() })

// ---------------------------------------------------------------- ports
const portGroup = {
  id: 'g-ports',
  kind: 'frontend',
  label: 'ports',
  command: `node -e "console.log('  ➜  Local:   http://localhost:5173/');console.error('EADDRINUSE 0.0.0.0:3000')"`,
  cwd: '',
  env: {},
  enabled: true,
}
supervisor.start('ws-feat', portGroup)
await sleep(1500)
const portsRun = supervisor.runsOf('ws-feat', [portGroup])['g-ports']
const ports = portsRun?.ports ?? []
check('ports extracted from stdout+stderr', ports.includes(5173) && ports.includes(3000), JSON.stringify(ports))
check('ports survive exit in run state', portsRun?.status === 'exited', JSON.stringify(portsRun?.status))

// ---------------------------------------------------------------- auto-restart
const crashGroup = {
  id: 'g-crash',
  kind: 'other',
  label: 'crasher',
  command: 'node -e "process.exit(3)"',
  cwd: '',
  env: {},
  enabled: true,
  autoRestart: true,
}
supervisor.start('ws-feat', crashGroup)
await sleep(3400) // exit ~300ms + 2s backoff + respawn + crash again
const crashRun = supervisor.runsOf('ws-feat', [crashGroup])['g-crash']
check('auto-restart issued after abnormal exit', (crashRun?.restarts ?? 0) >= 1, JSON.stringify({ restarts: crashRun?.restarts, status: crashRun?.status }))

// Manual start resets the counter.
supervisor.stop('ws-feat', crashGroup) // cancel any pending backoff timer
await sleep(400)
supervisor.start('ws-feat', crashGroup)
await sleep(1200)
const crashRun2 = supervisor.runsOf('ws-feat', [crashGroup])['g-crash']
check('manual start resets restart counter', (crashRun2?.restarts ?? 1) <= 1, JSON.stringify({ restarts: crashRun2?.restarts }))
supervisor.stop('ws-feat', crashGroup)

// A user-stopped process must NOT auto-restart.
const noRestartGroup = { ...crashGroup, id: 'g-norestart', command: 'node -e "setTimeout(()=>process.exit(1), 800)"' }
supervisor.start('ws-feat', noRestartGroup)
await sleep(300)
supervisor.stop('ws-feat', noRestartGroup)
await sleep(2600) // past the 2s backoff window
const noRun = supervisor.runsOf('ws-feat', [noRestartGroup])['g-norestart']
check('user stop never auto-restarts', (noRun?.restarts ?? 0) === 0 && noRun?.status === 'exited' && noRun?.stoppedByUser === true, JSON.stringify({ restarts: noRun?.restarts, status: noRun?.status, stoppedByUser: noRun?.stoppedByUser }))

// ---------------------------------------------------------------- readiness
// Reserve a free TCP port, release it, then let the child bind it.
const probePort = await new Promise(resolve => {
  const scout = createServer()
  scout.listen(0, '127.0.0.1', () => {
    const port = scout.address().port
    scout.close(() => resolve(port))
  })
})
const readyGroup = {
  id: 'g-ready',
  kind: 'backend',
  label: 'ready-server',
  command: `node -e "require('http').createServer((q,s)=>{s.end('ok')}).listen(${probePort},'127.0.0.1',()=>console.log('listening http://localhost:${probePort}'))"`,
  cwd: '',
  env: {},
  enabled: true,
  readyUrl: `http://127.0.0.1:${probePort}`,
}
supervisor.start('ws-feat', readyGroup)
await sleep(4200) // poll interval 1.5s + margin
let readyRun = supervisor.runsOf('ws-feat', [readyGroup])['g-ready']
check('readyUrl probe marks ready', readyRun?.ready === true, JSON.stringify({ ready: readyRun?.ready, status: readyRun?.status }))

// After a stop, ready must clear.
supervisor.stop('ws-feat', readyGroup)
await sleep(1200)
readyRun = supervisor.runsOf('ws-feat', [readyGroup])['g-ready']
check('ready clears after stop', readyRun?.ready !== true, JSON.stringify({ ready: readyRun?.ready, status: readyRun?.status }))

// A group WITHOUT readyUrl never reports ready.
const plainGroup = { ...readyGroup, id: 'g-plain', readyUrl: undefined }
supervisor.start('ws-feat', plainGroup)
await sleep(2200)
const plainRun = supervisor.runsOf('ws-feat', [plainGroup])['g-plain']
check('no readyUrl → never ready', plainRun?.ready !== true, JSON.stringify({ ready: plainRun?.ready }))
supervisor.stop('ws-feat', plainGroup)

supervisor.dispose()

// ---------------------------------------------------------------- protocol
const ws = normalizeWorkspaceConfig({
  groups: [
    { id: 'g-aaaa', kind: 'frontend', label: 'web', command: 'pnpm dev', cwd: '', env: {}, enabled: true },
    { id: 'g-bbbb', kind: 'backend', label: 'api', command: 'pnpm api', cwd: '', env: {}, enabled: true },
  ],
  profiles: [
    { id: 'p-1111', label: '仅前端', groupIds: ['g-aaaa'] },
    { id: 'p-2222', label: '坏成员', groupIds: ['g-aaaa', 'g-missing', 'g-aaaa', 42] },
    'garbage',
  ],
})
check('profiles kept', ws.profiles.length === 2, JSON.stringify(ws.profiles.map(p => p.id)))
check('unknown/dup members filtered', ws.profiles[1]?.groupIds.length === 1, JSON.stringify(ws.profiles[1]?.groupIds))
check('legacy config without profiles → empty', normalizeWorkspaceConfig({ groups: [] }).profiles.length === 0)

let threw = false
try { normalizeGroup({ id: 'g-zzzz', command: 'x', readyUrl: 'not a url' }) } catch { threw = true }
check('invalid readyUrl rejected', threw)
const withUrl = normalizeGroup({ id: 'g-yyyy', command: 'x', readyUrl: ' http://localhost:3000 ' })
check('valid readyUrl kept+trimmed', withUrl.readyUrl === 'http://localhost:3000', JSON.stringify(withUrl.readyUrl))
check('autoRestart opt-in only', withUrl.autoRestart === false)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
