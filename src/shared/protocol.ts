/**
 * Pure protocol core shared by the host and browser halves: the config
 * model (per-workspace launch groups), normalization + validation, and the
 * run-state projection. No I/O, no Cordis, no React — everything here is
 * unit-testable and structurally frozen on the wire.
 *
 * Model decisions (see devlaunch-analysis.md):
 * - Config is keyed by workspace id (stable UUID), NOT by session: every
 *   session of a project sees and controls the same set of processes.
 * - `kind` (frontend / backend / other) is purely presentational grouping.
 * - A group runs at most one process instance at a time (idempotent start).
 *
 * @module dsh-devlaunch/shared/protocol
 */

/** Presentational grouping kind for a launch group. */
export type GroupKind = 'frontend' | 'backend' | 'other'

/** All valid kinds, in display order. */
export const GROUP_KINDS: readonly GroupKind[] = ['frontend', 'backend', 'other']

/** One user-configured launch command group. */
export interface LaunchGroup {
  /** Stable id unique within the workspace (generated on create). */
  readonly id: string
  /** frontend / backend / other — presentational only. */
  readonly kind: GroupKind
  /** Human label shown in the button menu and console headers. */
  readonly label: string
  /** The command line, handed to the shell verbatim. */
  readonly command: string
  /** Working directory relative to the workspace root ('' = root). */
  readonly cwd: string
  /** Extra environment variables merged over the host env. */
  readonly env: Readonly<Record<string, string>>
  /** Whether the group participates in one-click "start all". */
  readonly enabled: boolean
  /** Readiness probe URL (absolute http(s)). ANY HTTP response marks ready. */
  readonly readyUrl?: string
  /** Auto-restart on abnormal exit (user stops never restart); backoff 2s→30s, max 5, resets after 30s stable uptime. */
  readonly autoRestart?: boolean
}

/** A named launch preset: a subset of group ids started together ("全量 / 仅前端 / …"). */
export interface LaunchProfile {
  /** Stable id unique within the workspace. */
  readonly id: string
  /** Human label shown on the profile chip. */
  readonly label: string
  /** Member group ids (validated against the workspace's groups on normalize). */
  readonly groupIds: readonly string[]
}

/** The config record for one workspace. */
export interface WorkspaceConfig {
  readonly groups: readonly LaunchGroup[]
  readonly profiles: readonly LaunchProfile[]
}

/** Whole-file config store shape. */
export interface ConfigFile {
  readonly schemaVersion: 1
  readonly workspaces: Readonly<Record<string, WorkspaceConfig>>
}

/** Live process state for one group (host projection, transient). */
export interface RunState {
  readonly status: 'stopped' | 'running' | 'exited'
  /** Process pid while running. */
  readonly pid?: number
  /** Epoch ms of the last start. */
  readonly startedAt?: number
  /** Epoch ms of the last exit. */
  readonly exitedAt?: number
  /** Exit code, when the process has exited. */
  readonly exitCode?: number | null
  /** True when the exit was caused by user stop. */
  readonly stoppedByUser?: boolean
  /** Spawn error message when the process could not even start. */
  readonly error?: string
  /** Health probe answered at readyUrl (only groups with readyUrl configured). */
  readonly ready?: boolean
  /** Automatic restarts after abnormal exits (0 = none; manual start resets). */
  readonly restarts?: number
  /** TCP ports seen in this run's output (localhost:NNNN / URL forms). */
  readonly ports?: readonly number[]
}

/** One output line batch for one group. */
export interface OutputChunk {
  /** Group id. */
  readonly g: string
  /** Monotonic sequence of the FIRST line in this batch. */
  readonly seq: number
  /** Lines (without trailing newline). */
  readonly lines: readonly string[]
  /** 'out' = stdout, 'err' = stderr. */
  readonly stream: 'out' | 'err'
}

/** Snapshot response of GET /state. */
export interface StateResponse {
  readonly workspaceId: string
  readonly config: WorkspaceConfig
  readonly runs: Readonly<Record<string, RunState>>
  /** Highest output seq ever emitted per group (for catch-up requests). */
  readonly seqByGroup: Readonly<Record<string, number>>
  /** Whether the host holds output history buffers. */
  readonly hasHistory: boolean
}

/** SSE event payload: config or run-state change. */
export type ChangeEvent =
  | { readonly type: 'state'; readonly workspaceId: string; readonly runs: Readonly<Record<string, RunState>> }
  | { readonly type: 'config'; readonly workspaceId: string }
  | { readonly type: 'output'; readonly workspaceId: string; readonly chunk: OutputChunk }
  | { readonly type: 'reset'; readonly workspaceId: string; readonly reason: 'host-restart' }

/** Result of a start/stop/restart action for one group. */
export interface ActionOutcome {
  readonly group: string
  readonly ok: boolean
  readonly detail?: string
}

/** One importable script suggestion from a discovered package.json. */
export interface ScriptSuggestion {
  /** Script name. */
  readonly name: string
  /** Ready-to-run command (`npm run <name>`). */
  readonly command: string
  /** Package directory relative to the workspace root ('' = root itself). */
  readonly cwd: string
  /** Package name from its manifest (fallback: directory basename). */
  readonly pkg: string
}

// ---------------------------------------------------------------------------
// Validation / normalization
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/
const LABEL_MAX = 60
const COMMAND_MAX = 2000
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** Max groups per workspace — a sanity ceiling, not a UX target. */
const MAX_GROUPS = 32
/** Max launch presets per workspace. */
const MAX_PROFILES = 8
/** Max member ids kept per profile after validation. */
const MAX_PROFILE_MEMBERS = 32

/** Is this a valid group kind on the wire? */
export function isGroupKind(value: unknown): value is GroupKind {
  return value === 'frontend' || value === 'backend' || value === 'other'
}

/** New opaque group id. */
export function newGroupId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `g-${rand}`
}

/** Normalize a relative cwd: strip leading ./, backslashes → /, no .. escape. */
export function normalizeCwd(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  let value = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (value === '.' ) value = ''
  const segs: string[] = []
  for (const seg of value.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (segs.length === 0) throw new Error('cwd 不能越出项目根目录（含 ..）')
      segs.pop()
      continue
    }
    segs.push(seg)
  }
  return segs.join('/')
}

/** Normalize + validate one launch group from untrusted JSON. Throws on violation. */
export function normalizeGroup(raw: unknown): LaunchGroup {
  if (typeof raw !== 'object' || raw === null) throw new Error('启动组必须是对象')
  const body = raw as Record<string, unknown>

  const id = typeof body.id === 'string' && ID_RE.test(body.id) ? body.id : newGroupId()

  const kind: GroupKind = isGroupKind(body.kind) ? body.kind : 'other'

  let label = typeof body.label === 'string' ? body.label.trim() : ''
  if (label.length === 0) label = kind === 'frontend' ? '前端' : kind === 'backend' ? '后端' : '命令'
  if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX)

  const command = typeof body.command === 'string' ? body.command.trim() : ''
  if (command.length === 0) throw new Error('启动命令不能为空')
  if (command.length > COMMAND_MAX) throw new Error('启动命令过长')

  const cwd = normalizeCwd(body.cwd)

  const env: Record<string, string> = {}
  if (body.env !== undefined) {
    if (typeof body.env !== 'object' || body.env === null || Array.isArray(body.env)) throw new Error('env 必须是对象')
    for (const [key, value] of Object.entries(body.env as Record<string, unknown>)) {
      if (!ENV_KEY_RE.test(key)) throw new Error(`env 变量名非法: ${key}`)
      if (typeof value !== 'string') throw new Error(`env 变量 ${key} 的值必须是字符串`)
      env[key] = value
    }
  }

  let readyUrl: string | undefined
  if (body.readyUrl !== undefined && body.readyUrl !== null && typeof body.readyUrl === 'string' && body.readyUrl.trim() !== '') {
    if (typeof body.readyUrl !== 'string') throw new Error('readyUrl 必须是字符串')
    const candidate = body.readyUrl.trim()
    let parsed: URL
    try { parsed = new URL(candidate) } catch { throw new Error('readyUrl 必须是合法的绝对 URL（如 http://localhost:3000）') }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('readyUrl 仅支持 http(s) 地址')
    readyUrl = candidate
  }

  return { id, kind, label, command, cwd, env, enabled: body.enabled !== false, readyUrl, autoRestart: body.autoRestart === true }
}

/** Normalize + validate a whole workspace config record. */
export function normalizeWorkspaceConfig(raw: unknown): WorkspaceConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('工作区配置必须是对象')
  const body = raw as Record<string, unknown>
  const rawGroups = Array.isArray(body.groups) ? body.groups : []
  if (rawGroups.length > MAX_GROUPS) throw new Error(`启动组数量超过上限 ${MAX_GROUPS}`)
  const groups = rawGroups.map(g => normalizeGroup(g))
  const seen = new Set<string>()
  for (const group of groups) {
    if (seen.has(group.id)) throw new Error(`启动组 id 重复: ${group.id}`)
    seen.add(group.id)
  }

  // Launch presets: tolerant of absent/legacy configs (missing → none).
  const groupIds = new Set(groups.map(g => g.id))
  const rawProfiles = Array.isArray(body.profiles) ? body.profiles.slice(0, MAX_PROFILES) : []
  const profiles: LaunchProfile[] = []
  const seenProfile = new Set<string>()
  for (const item of rawProfiles) {
    if (typeof item !== 'object' || item === null) continue
    const profile = item as Record<string, unknown>
    const id = typeof profile.id === 'string' && ID_RE.test(profile.id) ? profile.id : newGroupId()
    if (seenProfile.has(id)) continue
    let label = typeof profile.label === 'string' ? profile.label.trim() : ''
    if (label.length === 0) label = '预设'
    if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX)
    const members: string[] = []
    if (Array.isArray(profile.groupIds)) {
      for (const value of profile.groupIds) {
        if (typeof value !== 'string') continue
        if (!groupIds.has(value) || members.includes(value)) continue
        if (members.length >= MAX_PROFILE_MEMBERS) break
        members.push(value)
      }
    }
    seenProfile.add(id)
    profiles.push({ id, label, groupIds: members })
  }
  return { groups, profiles }
}

/** Parse the whole config file (tolerant: missing/corrupt → empty config). */
export function parseConfigFile(raw: string): ConfigFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { schemaVersion: 1, workspaces: {} }
  }
  if (typeof parsed !== 'object' || parsed === null) return { schemaVersion: 1, workspaces: {} }
  const body = parsed as Record<string, unknown>
  const workspaces: Record<string, WorkspaceConfig> = {}
  if (typeof body.workspaces === 'object' && body.workspaces !== null) {
    for (const [id, value] of Object.entries(body.workspaces as Record<string, unknown>)) {
      try {
        workspaces[id] = normalizeWorkspaceConfig(value)
      } catch {
        // A single corrupt workspace must not take the whole file down.
      }
    }
  }
  return { schemaVersion: 1, workspaces }
}

/** Serialize the config file (stable key order for readable diffs). */
export function serializeConfigFile(file: ConfigFile): string {
  const out: Record<string, unknown> = {
    schemaVersion: 1,
    workspaces: Object.fromEntries(
      Object.entries(file.workspaces)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, ws]) => [id, {
        groups: ws.groups.map(g => ({ ...g, env: { ...g.env } })),
        profiles: ws.profiles.map(p => ({ id: p.id, label: p.label, groupIds: [...p.groupIds] })),
      }]),
    ),
  }
  return `${JSON.stringify(out, null, 2)}\n`
}
