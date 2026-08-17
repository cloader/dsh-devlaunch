/**
 * ProcessSupervisor: spawns user-configured launch commands, supervises
 * them, ring-buffers their merged output, and emits events for the SSE
 * routes. One instance per host process; keyed by (workspaceId, groupId).
 *
 * Windows specifics (the hard part, see devlaunch-analysis.md §4):
 * - npm/pnpm are shell → cmd → node chains: `shell: true` is mandatory for
 *   the command line itself, and stopping must kill the WHOLE tree via
 *   `taskkill /PID <pid> /T /F`. Plain child.kill() only kills cmd.exe and
 *   orphans the real server.
 * - Output decoding is best-effort utf8: dev servers overwhelmingly emit
 *   utf8 (or ANSI); a mangled multibyte boundary degrades one line, never
 *   crashes the stream.
 *
 * Event fan-out: subscribers receive run-state changes and output batches.
 * The routes layer turns subscriptions into SSE streams; the supervisor
 * itself knows nothing about HTTP.
 *
 * @module dsh-devlaunch/host/supervisor
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { isWindows, killTree } from './platform.ts'
import type { LaunchGroup, OutputChunk, RunState } from '../shared/protocol.ts'

/** A live or remembered process instance for one group. */
interface Proc {
  readonly workspaceId: string
  group: LaunchGroup
  child: ChildProcess | undefined
  status: RunState['status']
  pid?: number
  startedAt?: number
  exitedAt?: number
  exitCode?: number | null
  stoppedByUser: boolean
  /** Restart request: respawn this group once the close event settles. */
  respawnOnClose: boolean
  error?: string
  /** Readiness (readyUrl probe answered) for the current run. */
  ready: boolean
  /** Automatic restarts issued for this run series (manual start resets). */
  restarts: number
  /** Pending auto-restart timer (failure backoff). */
  autoTimer?: ReturnType<typeof setTimeout>
  /** Readiness poll interval handle. */
  pollTimer?: ReturnType<typeof setInterval>
  /** In-flight readiness probe aborter. */
  pollAbort?: AbortController
  /** TCP ports mentioned in this run's output (capped). */
  ports: number[]
  /** Ring buffer of decoded lines: [seq, stream, text]. */
  history: Array<{ seq: number; stream: 'out' | 'err'; text: string }>
  /** Total bytes ever buffered (for the ceiling). */
  historyBytes: number
  /** Next output seq for this proc. */
  nextSeq: number
  /** Pending decode remainder for stdout / stderr. */
  pending: { out: string; err: string }
}

/** Events emitted to subscribers (the SSE layer). */
export type SupervisorEvent =
  | { readonly type: 'state'; readonly workspaceId: string }
  | { readonly type: 'output'; readonly workspaceId: string; readonly chunk: OutputChunk }

/** Narrow face the supervisor needs to resolve a workspace root directory. */
export interface WorkspaceRoots {
  /** Absolute path of the workspace root, or undefined when unknown. */
  root(workspaceId: string): string | undefined
}

/** Spawn dependency seam (tests inject a fake). */
export interface SpawnDeps {
  spawn(command: string, options: { cwd: string; env: Record<string, string>; shell: boolean }): ChildProcess
  now(): number
  /** Milliseconds after a stop request before a still-alive pid is force-killed again. */
  killGraceMs(): number
}

/** Real spawn deps over node:child_process. */
export function realSpawnDeps(): SpawnDeps {
  return {
    spawn: (command, options) => spawn(command, options),
    now: () => Date.now(),
    killGraceMs: () => 3_000,
  }
}

// ---------------------------------------------------------------------------
// Readiness / auto-restart / port-scan tuning (module constants)
// ---------------------------------------------------------------------------

/** Readiness probe cadence while a readyUrl group runs. */
const READY_POLL_MS = 1_500
/** Single readiness probe timeout (aborts, next tick retries). */
const READY_TIMEOUT_MS = 2_500
/** Auto-restart first delay; doubles per consecutive failure. */
const AUTO_RESTART_BASE_MS = 2_000
/** Auto-restart backoff ceiling. */
const AUTO_RESTART_MAX_MS = 30_000
/** Give up auto-restarting after this many consecutive failures. */
const AUTO_RESTART_MAX = 5
/** A run that stayed up this long resets the backoff series. */
const AUTO_RESET_UPTIME_MS = 30_000
/** Max distinct ports tracked per run. */
const MAX_PORTS = 8

/** localhost-ish host:port forms in process output ("http://localhost:5173", "0.0.0.0:3000"…). */
const PORT_RE = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g

/** Options. */
export interface SupervisorOptions {
  readonly roots: WorkspaceRoots
  readonly deps?: SpawnDeps
  /** Called when the supervisor wants to persist nothing (placeholder for symmetry). */
  readonly maxHistoryLines?: number
}

/**
 * The supervisor. All public methods are synchronous-fast; process events
 * arrive on the emitter.
 */
export class ProcessSupervisor extends EventEmitter {
  private readonly procs = new Map<string, Proc>()
  private readonly roots: WorkspaceRoots
  private readonly deps: SpawnDeps
  private readonly maxHistoryLines: number
  private shuttingDown = false

  constructor(options: SupervisorOptions) {
    super()
    this.roots = options.roots
    this.deps = options.deps ?? realSpawnDeps()
    this.maxHistoryLines = options.maxHistoryLines ?? 2000
  }

  /** Map key for a group. */
  private key(workspaceId: string, groupId: string): string {
    return `${workspaceId}::${groupId}`
  }

  /** Proc lookup, creating the remembered slot on demand. */
  private ensure(workspaceId: string, group: LaunchGroup): Proc {
    const key = this.key(workspaceId, group.id)
    let proc = this.procs.get(key)
    if (proc === undefined) {
      proc = {
        workspaceId,
        group,
        child: undefined,
        status: 'stopped',
        stoppedByUser: false,
        respawnOnClose: false,
        ready: false,
        restarts: 0,
        ports: [],
        history: [],
        historyBytes: 0,
        nextSeq: 1,
        pending: { out: '', err: '' },
      }
      this.procs.set(key, proc)
    } else {
      // Config may have changed the group between runs; refresh the copy.
      proc.group = group
    }
    return proc
  }

  /** Run-state projection for one workspace (all known groups). */
  runsOf(workspaceId: string, groups: readonly LaunchGroup[]): Record<string, RunState> {
    const runs: Record<string, RunState> = {}
    for (const group of groups) {
      const proc = this.procs.get(this.key(workspaceId, group.id))
      runs[group.id] = proc === undefined ? { status: 'stopped' } : this.projectRun(proc)
    }
    return runs
  }

  /** Project one proc to its wire run state. */
  private projectRun(proc: Proc): RunState {
    const state: { status: RunState['status']; [key: string]: unknown } = { status: proc.status }
    if (proc.pid !== undefined) state.pid = proc.pid
    if (proc.startedAt !== undefined) state.startedAt = proc.startedAt
    if (proc.exitedAt !== undefined) state.exitedAt = proc.exitedAt
    if (proc.exitCode !== undefined) state.exitCode = proc.exitCode
    if (proc.stoppedByUser) state.stoppedByUser = true
    if (proc.error !== undefined) state.error = proc.error
    if (proc.ready) state.ready = true
    if (proc.restarts > 0) state.restarts = proc.restarts
    if (proc.ports.length > 0) state.ports = [...proc.ports]
    return state as RunState
  }

  /** Is the group currently running? */
  isRunning(workspaceId: string, groupId: string): boolean {
    return this.procs.get(this.key(workspaceId, groupId))?.status === 'running'
  }

  /**
   * Start one group. Idempotent: a running group is reported as skipped.
   * options.preserveRestarts keeps the auto-restart backoff series
   * (internal respawns only — a manual start always resets the counter).
   * Returns a per-group outcome.
   */
  start(workspaceId: string, group: LaunchGroup, options: { preserveRestarts?: boolean } = {}): { ok: boolean; detail?: string } {
    if (this.shuttingDown) return { ok: false, detail: 'host 正在关闭' }
    const proc = this.ensure(workspaceId, group)
    if (proc.status === 'running') return { ok: false, detail: '已在运行' }

    const root = this.roots.root(workspaceId)
    if (root === undefined) return { ok: false, detail: '项目根目录未知（workspace 尚未挂载？）' }

    const cwd = group.cwd === '' ? root : joinPath(root, group.cwd)
    const env = { ...processEnv(), ...group.env }

    // Cancel any pending failure backoff; a manual start is a fresh intent.
    this.clearAutoTimer(proc)
    proc.stoppedByUser = false
    proc.respawnOnClose = false
    proc.error = undefined
    proc.exitCode = undefined
    proc.exitedAt = undefined
    proc.child = undefined
    proc.pending = { out: '', err: '' }
    proc.nextSeq = 1
    proc.history = []
    proc.historyBytes = 0
    proc.ready = false
    proc.ports = []
    if (options.preserveRestarts !== true) proc.restarts = 0

    let child: ChildProcess
    try {
      child = this.deps.spawn(group.command, { cwd, env, shell: true })
    } catch (error) {
      proc.status = 'exited'
      proc.error = `无法启动: ${errorMessage(error)}`
      this.emitState(workspaceId, proc)
      return { ok: false, detail: proc.error }
    }
    proc.child = child
    proc.status = 'running'
    proc.startedAt = this.deps.now()
    proc.pid = child.pid

    // A spawn error can also surface asynchronously via 'error'.
    child.on('error', error => {
      if (proc.status !== 'running') return
      proc.status = 'exited'
      proc.exitedAt = this.deps.now()
      proc.error = `启动失败: ${errorMessage(error)}`
      this.emitState(workspaceId, proc)
    })

    child.stdout?.on('data', (buf: Buffer) => this.ingest(workspaceId, proc, buf, 'out'))
    child.stderr?.on('data', (buf: Buffer) => this.ingest(workspaceId, proc, buf, 'err'))

    // Readiness probing runs only while this child lives.
    this.startReadinessPoll(workspaceId, proc)

    child.on('close', (code) => {
      // Flush any pending partial line.
      this.flushPending(workspaceId, proc, 'out')
      this.flushPending(workspaceId, proc, 'err')
      this.stopReadinessPoll(proc)
      proc.ready = false
      if (proc.status !== 'running') return
      proc.status = 'exited'
      proc.exitedAt = this.deps.now()
      proc.exitCode = code
      // A run that stayed up long enough resets the failure series: the
      // next crash starts a fresh backoff instead of stacking onto old ones.
      const uptime = proc.exitedAt - (proc.startedAt ?? proc.exitedAt)
      if (uptime > AUTO_RESET_UPTIME_MS) proc.restarts = 0
      this.emitState(workspaceId, proc)
      // A restart request waits for exactly this moment: the old tree is
      // settled (pid dead, pipes closed), so the respawn cannot race the
      // kill or inherit a dying pipe.
      if (proc.respawnOnClose) {
        proc.respawnOnClose = false
        queueMicrotask(() => { this.start(workspaceId, proc.group) })
        return
      }
      // Auto-restart on abnormal exit (never after a user stop; spawn
      // failures surface as 'error' before close and are skipped too).
      if (proc.group.autoRestart === true && !proc.stoppedByUser && code !== null && code !== 0 && proc.restarts < AUTO_RESTART_MAX) {
        proc.restarts += 1
        const delay = Math.min(AUTO_RESTART_BASE_MS * 2 ** (proc.restarts - 1), AUTO_RESTART_MAX_MS)
        proc.autoTimer = setTimeout(() => {
          proc.autoTimer = undefined
          if (this.shuttingDown || proc.status !== 'exited') return
          this.start(workspaceId, proc.group, { preserveRestarts: true })
        }, delay)
        proc.autoTimer.unref?.()
      }
    })

    this.emitState(workspaceId, proc)
    return { ok: true }
  }

  /**
   * Stop one group: best-effort tree kill. Also cancels a pending
   * auto-restart (a stop during the backoff wait is a user intent and must
   * not be undone by the timer). Returns ok=false when not running.
   */
  stop(workspaceId: string, group: LaunchGroup): { ok: boolean; detail?: string } {
    const proc = this.procs.get(this.key(workspaceId, group.id))
    if (proc === undefined) return { ok: false, detail: '未在运行' }
    this.clearAutoTimer(proc)
    this.stopReadinessPoll(proc)
    if (proc.status !== 'running' || proc.child === undefined) {
      proc.stoppedByUser = true
      return { ok: false, detail: '未在运行' }
    }
    proc.stoppedByUser = true
    killTree(proc.child, proc.pid, isWindows())
    // Belt and braces: if the tree somehow survives, close stdin and retry
    // once after the grace period.
    const grace = this.deps.killGraceMs()
    const child = proc.child
    setTimeout(() => {
      if (proc.status === 'running' && proc.child === child) {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
    }, grace).unref?.()
    return { ok: true }
  }

  /**
   * Restart: when running, arm a respawn on the close event (the tree kill
   * is asynchronous — respawning before 'close' would race the kill, hit the
   * still-'running' status, and report "已在运行"); when not running, start
   * immediately.
   */
  restart(workspaceId: string, group: LaunchGroup): { ok: boolean; detail?: string } {
    const proc = this.procs.get(this.key(workspaceId, group.id))
    if (proc !== undefined && proc.status === 'running') {
      proc.respawnOnClose = true
      this.stop(workspaceId, group)
      return { ok: true, detail: '正在重启' }
    }
    return this.start(workspaceId, group)
  }

  /** Buffered history for catch-up: lines with seq > afterSeq. */
  historyAfter(workspaceId: string, groupId: string, afterSeq: number): OutputChunk[] {
    const proc = this.procs.get(this.key(workspaceId, groupId))
    if (proc === undefined) return []
    const chunks: Array<{ g: string; seq: number; lines: string[]; stream: 'out' | 'err' }> = []
    for (const line of proc.history) {
      if (line.seq <= afterSeq) continue
      const last = chunks.at(-1)
      if (last !== undefined && last.stream === line.stream && last.seq + last.lines.length === line.seq) {
        last.lines.push(line.text)
      } else {
        chunks.push({ g: groupId, seq: line.seq, lines: [line.text], stream: line.stream })
      }
    }
    return chunks
  }

  /** Highest seq emitted for the group (0 when never run). */
  seqOf(workspaceId: string, groupId: string): number {
    const proc = this.procs.get(this.key(workspaceId, groupId))
    if (proc === undefined || proc.history.length === 0) return 0
    return proc.history.at(-1)?.seq ?? 0
  }

  /** True when the group has any buffered history (advertised on /state). */
  hasHistoryFor(workspaceId: string, groupId: string): boolean {
    return (this.procs.get(this.key(workspaceId, groupId))?.history.length ?? 0) > 0
  }

  /** Clear a pending auto-restart timer (no-op when none). */
  private clearAutoTimer(proc: Proc): void {
    if (proc.autoTimer !== undefined) {
      clearTimeout(proc.autoTimer)
      proc.autoTimer = undefined
    }
  }

  /** Begin the readiness probe loop for this run (no-op without readyUrl). */
  private startReadinessPoll(workspaceId: string, proc: Proc): void {
    this.stopReadinessPoll(proc)
    const url = proc.group.readyUrl
    if (url === undefined || url === '') return

    /** One probe: ANY HTTP response means the server is listening. */
    const probe = async (): Promise<void> => {
      if (proc.status !== 'running' || proc.child === undefined || proc.ready) return
      const abort = new AbortController()
      proc.pollAbort = abort
      const timeout = setTimeout(() => { abort.abort() }, READY_TIMEOUT_MS)
      timeout.unref?.()
      try {
        await fetch(url, { signal: abort.signal, redirect: 'follow' })
        if (proc.status === 'running' && !proc.ready) {
          proc.ready = true
          this.stopReadinessPoll(proc)
          this.emit('state', { type: 'state', workspaceId } satisfies SupervisorEvent)
        }
      } catch {
        // Connection refused / timeout / aborted: keep polling on the next tick.
      } finally {
        clearTimeout(timeout)
      }
    }

    proc.pollTimer = setInterval(() => { void probe() }, READY_POLL_MS)
    proc.pollTimer.unref?.()
    void probe()
  }

  /** Stop the readiness probe loop and abort an in-flight probe. */
  private stopReadinessPoll(proc: Proc): void {
    if (proc.pollTimer !== undefined) {
      clearInterval(proc.pollTimer)
      proc.pollTimer = undefined
    }
    if (proc.pollAbort !== undefined) {
      proc.pollAbort.abort()
      proc.pollAbort = undefined
    }
  }

  /** Extract localhost-ish ports mentioned in one output line. */
  private scanPorts(proc: Proc, line: string): void {
    if (proc.ports.length >= MAX_PORTS) return
    for (const match of line.matchAll(PORT_RE)) {
      const port = Number(match[1])
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      if (!proc.ports.includes(port)) {
        proc.ports.push(port)
        if (proc.ports.length >= MAX_PORTS) return
      }
    }
  }

  /** Ingest one stdout/stderr data chunk: decode, split lines, buffer, emit. */
  private ingest(workspaceId: string, proc: Proc, buf: Buffer, stream: 'out' | 'err'): void {
    const text = proc.pending[stream] + buf.toString('utf8')
    const lines = text.split('\n')
    proc.pending[stream] = lines.pop() ?? ''
    this.pushLines(workspaceId, proc, lines, stream)
  }

  /** Flush a pending partial line (on process close). */
  private flushPending(workspaceId: string, proc: Proc, stream: 'out' | 'err'): void {
    const rest = proc.pending[stream]
    if (rest === '') return
    proc.pending[stream] = ''
    this.pushLines(workspaceId, proc, [rest], stream)
  }

  /** Buffer lines (respecting the ceiling) and emit one output event. */
  private pushLines(workspaceId: string, proc: Proc, lines: string[], stream: 'out' | 'err'): void {
    if (lines.length === 0) return
    const seqs: number[] = []
    const texts: string[] = []
    for (const rawLine of lines) {
      // Strip a trailing \r (CRLF); ANSI escapes are kept — the browser
      // renders them away (see client ansi handling).
      const line = rawLine.replace(/\r$/, '')
      this.scanPorts(proc, line)
      const seq = proc.nextSeq++
      seqs.push(seq)
      texts.push(line)
      proc.history.push({ seq, stream, text: line })
      proc.historyBytes += line.length + 1
    }
    // Enforce the line ceiling.
    while (proc.history.length > this.maxHistoryLines) proc.history.shift()
    const firstSeq = seqs[0] ?? 0
    this.emit('output', {
      type: 'output',
      workspaceId,
      chunk: { g: proc.group.id, seq: firstSeq, lines: texts, stream },
    } satisfies SupervisorEvent)
  }

  /** Emit a state event for the proc's workspace. */
  private emitState(workspaceId: string, _proc: Proc): void {
    // The routes layer re-projects runs against the CURRENT config groups,
    // so the payload is refreshed by the subscriber via runsOf(); here we
    // only signal which workspace changed.
    this.emit('state', { type: 'state', workspaceId } satisfies SupervisorEvent)
  }

  /** Snapshot of every workspace's running keys (for dispose-all). */
  runningWorkspaces(): string[] {
    const ids = new Set<string>()
    for (const proc of this.procs.values()) {
      if (proc.status === 'running') ids.add(proc.workspaceId)
    }
    return [...ids]
  }

  /**
   * Stop everything (host dispose). Default policy: kill the trees — a
   * closed host cannot supervise orphans, and users said the GUI closing
   * should not leave stray dev servers.
   */
  dispose(): void {
    this.shuttingDown = true
    for (const proc of this.procs.values()) {
      this.clearAutoTimer(proc)
      this.stopReadinessPoll(proc)
      if (proc.status === 'running' && proc.child !== undefined) {
        proc.stoppedByUser = true
        try { killTree(proc.child, proc.pid, isWindows()) } catch { /* best effort */ }
      }
    }
    this.removeAllListeners()
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Join root + relative cwd without node:path (Windows-safe already normalized). */
export function joinPath(root: string, cwd: string): string {
  if (cwd === '') return root
  return `${root.replace(/[\\/]+$/, '')}\\${cwd.replace(/\//g, '\\')}`
}

/** process.env copy as Record<string,string> (drops undefined values). */
export function processEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/** Readable message from an unknown error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Random-ish uuid (used by tests; imported here so node:crypto stays host-side). */
export function randomId(): string {
  return randomUUID()
}
