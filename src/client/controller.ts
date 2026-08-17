/**
 * DevlaunchController: the browser-side state mirror. One instance per page
 * (NOT per session): processes are per-workspace, and several sessions of
 * the same workspace must see the same picture. Session-scoped slot
 * components subscribe by workspaceId and read snapshots.
 *
 * Data path: same-origin fetch for actions/config + one SSE stream per
 * ACTIVE workspace (opened lazily when a session of that workspace is
 * mounted, closed after a idle timeout when none remains).
 *
 * @module dsh-devlaunch/client/controller
 */
import type {
  ActionOutcome,
  ConfigFile,
  LaunchGroup,
  LaunchProfile,
  OutputChunk,
  RunState,
  ScriptSuggestion,
  StateResponse,
  WorkspaceConfig,
} from '../shared/protocol.ts'

/** One console line as kept client-side. */
export interface ConsoleLine {
  readonly seq: number
  readonly stream: 'out' | 'err'
  readonly text: string
}

/** View state for one workspace. */
export interface WorkspaceView {
  readonly workspaceId: string
  config: WorkspaceConfig
  runs: Record<string, RunState>
  /** Output lines per group (bounded). */
  lines: Map<string, ConsoleLine[]>
  /** Highest seq per group. */
  seq: Record<string, number>
  connected: boolean
  lastError?: string
}

/** Max lines kept per group client-side (UI window; host keeps 2000). */
const CLIENT_MAX_LINES = 2000

/** Idle ms before an unsubscribed workspace's stream closes. */
const STREAM_IDLE_MS = 30_000

/** localStorage keys (per browser, best-effort). */
const LS_PROFILE_KEY = 'dsh-devlaunch:profile-selection'
const LS_PROFILE_MAX = 64

/**
 * Cross-group port conflicts: a port held by 2+ RUNNING groups. Returns
 * groupId → conflicting port. Pure function over a runs record.
 */
export function portConflicts(runs: Readonly<Record<string, RunState>>): Map<string, number> {
  const byPort = new Map<number, string[]>()
  for (const [groupId, run] of Object.entries(runs)) {
    if (run.status !== 'running') continue
    for (const port of run.ports ?? []) {
      const holders = byPort.get(port) ?? []
      holders.push(groupId)
      byPort.set(port, holders)
    }
  }
  const conflicts = new Map<string, number>()
  for (const [port, holders] of byPort) {
    if (holders.length < 2) continue
    for (const groupId of holders) conflicts.set(groupId, port)
  }
  return conflicts
}

/** POST helper with envelope unwrapping. */
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => null)) as { ok: boolean; value?: T; error?: { message: string } } | null
  if (parsed === null) throw new Error(`devlaunch: HTTP ${res.status}`)
  if (!parsed.ok) throw new Error(`devlaunch: ${parsed.error?.message ?? res.status}`)
  return parsed.value as T
}

/** GET helper. */
async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  const parsed = (await res.json().catch(() => null)) as { ok: boolean; value?: T; error?: { message: string } } | null
  if (parsed === null) throw new Error(`devlaunch: HTTP ${res.status}`)
  if (!parsed.ok) throw new Error(`devlaunch: ${parsed.error?.message ?? res.status}`)
  return parsed.value as T
}

/** Listener for whole-controller changes (components re-read snapshots). */
type Listener = () => void

/** Read the persisted per-workspace preset selection (best-effort). */
function readPersistedProfiles(): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const raw = localStorage.getItem(LS_PROFILE_KEY)
    if (raw === null) return out
    const parsed = JSON.parse(raw) as Record<string, unknown>
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out.set(id, value)
    }
  } catch { /* corrupt or unavailable: fall back to empty */ }
  return out
}

/**
 * The controller.
 */
export class DevlaunchController {
  private readonly views = new Map<string, WorkspaceView>()
  private readonly listeners = new Set<Listener>()
  /** Reference counts: how many mounted components care per workspace. */
  private readonly refs = new Map<string, number>()
  private readonly streams = new Map<string, EventSource>()
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Selected launch preset per workspace ('' = 全部/all-enabled). */
  private readonly profileSel = new Map<string, string>()

  constructor() {
    this.profileSel = readPersistedProfiles()
  }

  /** Subscribe to all changes; returns unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Currently selected preset id for a workspace ('' = 全部). */
  selectedProfile(workspaceId: string): string {
    return this.profileSel.get(workspaceId) ?? ''
  }

  /** Select a preset (persisted per browser, best-effort). */
  setSelectedProfile(workspaceId: string, profileId: string): void {
    this.profileSel.set(workspaceId, profileId)
    try {
      const all = readPersistedProfiles()
      all.set(workspaceId, profileId)
      // Bound the persisted map so ancient workspaces don't accumulate.
      while (all.size > LS_PROFILE_MAX) {
        const first = all.keys().next().value
        if (first === undefined) break
        all.delete(first)
      }
      const record: Record<string, string> = {}
      for (const [id, value] of all) record[id] = value
      localStorage.setItem(LS_PROFILE_KEY, JSON.stringify(record))
    } catch { /* storage unavailable: selection stays in-memory */ }
    this.notify()
  }

  /**
   * Resolve the current start target for a workspace: the selected
   * preset's group ids, or undefined meaning "all enabled groups".
   */
  profileTarget(workspaceId: string): { profileId: string; label: string; groupIds: string[] | undefined } {
    const view = this.views.get(workspaceId)
    const profiles: readonly LaunchProfile[] = view?.config.profiles ?? []
    const profile = profiles.find(p => p.id === this.selectedProfile(workspaceId))
    if (profile === undefined) return { profileId: '', label: '全部', groupIds: undefined }
    const known = new Set((view?.config.groups ?? []).map(g => g.id))
    return { profileId: profile.id, label: profile.label, groupIds: profile.groupIds.filter(id => known.has(id)) }
  }

  /**
   * Start the current target (preset groups, or all enabled) and stop any
   * RUNNING group outside the preset — one-click "switch the running set".
   * The all-enabled target keeps legacy behavior (starts enabled, stops nothing).
   */
  async startTarget(workspaceId: string): Promise<{ outcomes: ActionOutcome[] }> {
    const { groupIds } = this.profileTarget(workspaceId)
    const outcomes = await this.start(workspaceId, groupIds)
    if (groupIds === undefined) return outcomes
    // Pull fresh runs, then stop outsiders.
    await this.refreshState(workspaceId).catch(() => {})
    const view = this.views.get(workspaceId)
    if (view === undefined) return outcomes
    const outside = Object.entries(view.runs)
      .filter(([id, run]) => run.status === 'running' && !groupIds.includes(id))
      .map(([id]) => id)
    if (outside.length > 0) await this.stop(workspaceId, outside).catch(() => {})
    return outcomes
  }

  /** Notify listeners (batched into a microtask). */
  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** View for a workspace (undefined until first state arrives). */
  view(workspaceId: string): WorkspaceView | undefined {
    return this.views.get(workspaceId)
  }

  /**
   * A component mounted for this workspace: ref-count the stream and pull
   * fresh state. Returns the release function.
   */
  acquire(workspaceId: string): () => void {
    const count = this.refs.get(workspaceId) ?? 0
    this.refs.set(workspaceId, count + 1)
    const idle = this.idleTimers.get(workspaceId)
    if (idle !== undefined) {
      clearTimeout(idle)
      this.idleTimers.delete(workspaceId)
    }
    if (count === 0) this.openStream(workspaceId)
    return () => { this.release(workspaceId) }
  }

  /** Reference dropped; maybe close the stream after idling. */
  private release(workspaceId: string): void {
    const count = (this.refs.get(workspaceId) ?? 1) - 1
    if (count > 0) {
      this.refs.set(workspaceId, count)
      return
    }
    this.refs.set(workspaceId, 0)
    const timer = setTimeout(() => {
      if ((this.refs.get(workspaceId) ?? 0) > 0) return
      this.closeStream(workspaceId)
      this.idleTimers.delete(workspaceId)
    }, STREAM_IDLE_MS)
    this.idleTimers.set(workspaceId, timer)
  }

  /** Open (or re-open) the SSE stream for a workspace. */
  private openStream(workspaceId: string): void {
    this.closeStream(workspaceId)
    const source = new EventSource(`/dsh-devlaunch/stream?workspace=${encodeURIComponent(workspaceId)}`)
    const view = this.ensureView(workspaceId)

    source.onopen = () => {
      view.connected = true
      this.notify()
    }
    source.onerror = () => {
      view.connected = false
      this.notify()
      // EventSource auto-reconnects; nothing else to do.
    }
    source.onmessage = (event: MessageEvent<string>) => {
      this.handleEvent(workspaceId, event.data)
    }
    this.streams.set(workspaceId, source)

    // Fresh state pull (the stream's initial snapshot may race config edits).
    void this.refreshState(workspaceId)
  }

  /** Close the SSE stream. */
  private closeStream(workspaceId: string): void {
    const source = this.streams.get(workspaceId)
    if (source !== undefined) {
      source.close()
      this.streams.delete(workspaceId)
    }
  }

  /** View slot creator. */
  private ensureView(workspaceId: string): WorkspaceView {
    let view = this.views.get(workspaceId)
    if (view === undefined) {
      view = {
        workspaceId,
        config: { groups: [], profiles: [] },
        runs: {},
        lines: new Map(),
        seq: {},
        connected: false,
      }
      this.views.set(workspaceId, view)
    }
    return view
  }

  /** One SSE data payload. */
  private handleEvent(workspaceId: string, raw: string): void {
    let event: { type: string; runs?: Record<string, RunState>; chunk?: OutputChunk }
    try {
      event = JSON.parse(raw) as typeof event
    } catch {
      return
    }
    const view = this.ensureView(workspaceId)
    if (event.type === 'state' && event.runs !== undefined) {
      view.runs = event.runs
      this.notify()
      return
    }
    if (event.type === 'output' && event.chunk !== undefined) {
      this.appendChunk(view, event.chunk)
      this.notify()
      return
    }
    if (event.type === 'config') {
      void this.refreshState(workspaceId)
    }
    // 'reset' (host restart): re-pull state + history gap.
    if (event.type === 'reset') {
      void this.refreshState(workspaceId)
    }
  }

  /** Append one output chunk to the view. */
  private appendChunk(view: WorkspaceView, chunk: OutputChunk): void {
    let lines = view.lines.get(chunk.g)
    if (lines === undefined) {
      lines = []
      view.lines.set(chunk.g, lines)
    }
    // Gap detection: if the chunk's first seq is beyond our last+1, we lost
    // lines (reconnect window). Pull history once to mend.
    const lastSeq = view.seq[chunk.g] ?? 0
    if (chunk.seq > lastSeq + 1 && lastSeq > 0) {
      void this.mendHistory(view.workspaceId, chunk.g, lastSeq)
    }
    chunk.lines.forEach((text, index) => {
      lines!.push({ seq: chunk.seq + index, stream: chunk.stream, text })
    })
    if (lines.length > CLIENT_MAX_LINES) lines.splice(0, lines.length - CLIENT_MAX_LINES)
    view.seq[chunk.g] = Math.max(lastSeq, chunk.seq + chunk.lines.length - 1)
  }

  /** Fetch missed lines for one group after a detected gap. */
  private async mendHistory(workspaceId: string, groupId: string, afterSeq: number): Promise<void> {
    try {
      const value = await get<{ chunks: OutputChunk[] }>(`/dsh-devlaunch/history?workspace=${encodeURIComponent(workspaceId)}&group=${encodeURIComponent(groupId)}&afterSeq=${afterSeq}`)
      const view = this.views.get(workspaceId)
      if (view === undefined) return
      const lines = view.lines.get(groupId) ?? []
      const known = new Set(lines.map(line => line.seq))
      for (const chunk of value.chunks) {
        chunk.lines.forEach((text, index) => {
          const seq = chunk.seq + index
          if (!known.has(seq)) lines.push({ seq, stream: chunk.stream, text })
        })
      }
      lines.sort((a, b) => a.seq - b.seq)
      if (lines.length > CLIENT_MAX_LINES) lines.splice(0, lines.length - CLIENT_MAX_LINES)
      view.seq[groupId] = lines.length > 0 ? lines[lines.length - 1]!.seq : 0
      this.notify()
    } catch {
      // Best effort: the live stream continues regardless.
    }
  }

  /** Full state pull (config + runs + whether history exists). */
  async refreshState(workspaceId: string): Promise<void> {
    try {
      const state = await get<StateResponse>(`/dsh-devlaunch/state?workspace=${encodeURIComponent(workspaceId)}`)
      const view = this.ensureView(workspaceId)
      view.config = state.config
      view.runs = state.runs
      view.connected = true
      this.notify()
    } catch (error) {
      const view = this.ensureView(workspaceId)
      view.connected = false
      view.lastError = error instanceof Error ? error.message : String(error)
      this.notify()
    }
  }

  /** Save a workspace config (replaces all groups). */
  async saveConfig(workspaceId: string, config: unknown): Promise<void> {
    await post('/dsh-devlaunch/config', { workspace: workspaceId, config })
    await this.refreshState(workspaceId)
  }

  /** Start groups (default: all enabled). */
  async start(workspaceId: string, groupIds?: string[]): Promise<{ outcomes: ActionOutcome[] }> {
    return post<{ outcomes: ActionOutcome[] }>('/dsh-devlaunch/start', { workspace: workspaceId, groupIds })
  }

  /** Stop groups (default: all running). */
  async stop(workspaceId: string, groupIds?: string[]): Promise<{ outcomes: ActionOutcome[] }> {
    return post<{ outcomes: ActionOutcome[] }>('/dsh-devlaunch/stop', { workspace: workspaceId, groupIds })
  }

  /** Restart one group. */
  async restart(workspaceId: string, groupId: string): Promise<{ outcomes: ActionOutcome[] }> {
    return post<{ outcomes: ActionOutcome[] }>('/dsh-devlaunch/restart', { workspace: workspaceId, group: groupId })
  }

  /** Fetch package.json script suggestions (root + subdirectories). */
  async packageScripts(workspaceId: string): Promise<ScriptSuggestion[]> {
    const value = await get<{ scripts: ScriptSuggestion[] }>(`/dsh-devlaunch/package-scripts?workspace=${encodeURIComponent(workspaceId)}`)
    return value.scripts
  }

  /** Clear the client-side output lines of one group (visual clear only). */
  clearLines(workspaceId: string, groupId: string): void {
    const view = this.views.get(workspaceId)
    if (view === undefined) return
    view.lines.set(groupId, [])
    this.notify()
  }

  /** Tear everything down (plugin dispose). */
  dispose(): void {
    for (const source of this.streams.values()) source.close()
    this.streams.clear()
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    this.listeners.clear()
  }
}
