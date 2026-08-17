/**
 * /dsh-devlaunch routes on the shared DSH webserver:
 *
 * - GET  /dsh-devlaunch/state?workspace=<id>            config + run states
 * - POST /dsh-devlaunch/config   {workspace, config}    replace workspace config
 * - POST /dsh-devlaunch/start    {workspace, groupIds?} start (default: enabled)
 * - POST /dsh-devlaunch/stop     {workspace, groupIds?} stop
 * - POST /dsh-devlaunch/restart  {workspace, groupId}   restart one group
 * - GET  /dsh-devlaunch/history?workspace=<id>&group=<g>&afterSeq=<n> catch-up
 * - GET  /dsh-devlaunch/stream?workspace=<id>           SSE (state/config/output/reset)
 * - GET  /dsh-devlaunch/package-scripts?workspace=<id>  package.json scripts scan
 *
 * Same-origin with the GUI (taskboard precedent), no auth surface added.
 *
 * @module dsh-devlaunch/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { LaunchGroup, OutputChunk, RunState, StateResponse } from '../shared/protocol.ts'
import { ROUTE_PREFIX, STREAM_PATH, type ApiResult } from '../shared/api.ts'
import type { ConfigStore } from './config.ts'
import { scanPackageScripts } from './scanner.ts'
import type { ProcessSupervisor } from './supervisor.ts'

/** SSE heartbeat cadence. */
const HEARTBEAT_MS = 20_000

/** The workspaces face routes need. */
export interface RoutesWorkspaceFace {
  /** Get a workspace by id → { id, path, title }. */
  get(id: string): { id: string; path: string; title: string } | undefined
  /** Resolve the workspace owning a canonical cwd. */
  resolveByPath(path: string): Promise<{ id: string } | undefined>
}

/** Options. */
export interface RoutesOptions {
  store: ConfigStore
  supervisor: ProcessSupervisor
  workspaces: RoutesWorkspaceFace
}

/** JSON-envelope writer. */
function json(res: ServerResponse, payload: ApiResult<unknown>, status = 200): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Failure envelope + status. */
function fail(code: 'invalid_input' | 'not_found' | 'internal', message: string): { res: ApiResult<never>; status: number } {
  const status = code === 'invalid_input' ? 400 : code === 'not_found' ? 404 : 500
  return { res: { ok: false, error: { code, message } }, status }
}

/** Read one JSON body (null on parse failure). */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** ?workspace=... extractor. */
function queryWorkspace(url: string): string | undefined {
  const match = /[?&]workspace=([^&]+)/.exec(url ?? '')
  return match === null ? undefined : decodeURIComponent(match[1]!)
}

/** ?group=... / ?afterSeq=... extractors. */
function queryParam(url: string, key: string): string | undefined {
  const match = new RegExp(`[?&]${key}=([^&]*)`).exec(url ?? '')
  return match === null ? undefined : decodeURIComponent(match[1]!)
}

/** String array field of a JSON body. */
function strArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    out.push(item)
  }
  return out
}

/**
 * Register the routes. Returns a disposer.
 */
export function registerDevlaunchRoutes(ctx: Context, options: RoutesOptions): () => void {
  const { store, supervisor, workspaces } = options

  /** Resolve groups by id list, or default to enabled groups. */
  const resolveGroups = (workspaceId: string, groupIds: string[] | undefined): { groups: LaunchGroup[]; error?: string } => {
    const config = store.get(workspaceId)
    if (groupIds === undefined) return { groups: config.groups.filter(g => g.enabled) }
    const groups: LaunchGroup[] = []
    for (const id of groupIds) {
      const group = config.groups.find(g => g.id === id)
      if (group === undefined) return { groups: [], error: `未知启动组: ${id}` }
      groups.push(group)
    }
    return { groups }
  }

  /** Build the state response. */
  const stateResponse = (workspaceId: string): StateResponse => {
    const config = store.get(workspaceId)
    const runs: Record<string, RunState> = supervisor.runsOf(workspaceId, config.groups)
    const seqByGroup: Record<string, number> = {}
    let hasHistory = false
    for (const group of config.groups) {
      seqByGroup[group.id] = supervisor.seqOf(workspaceId, group.id)
      if (supervisor.hasHistoryFor(workspaceId, group.id)) hasHistory = true
    }
    return { workspaceId, config, runs, seqByGroup, hasHistory }
  }

  // -------------------------------------------------------------------------
  // SSE stream
  // -------------------------------------------------------------------------
  /** Per-workspace subscriber sets. */
  const subscribers = new Map<string, Set<ServerResponse>>()

  /** Broadcast a serialized event to one workspace's streams. */
  const broadcast = (workspaceId: string, event: unknown): void => {
    const set = subscribers.get(workspaceId)
    if (set === undefined || set.size === 0) return
    const payload = `data: ${JSON.stringify(event)}\n\n`
    for (const res of set) {
      try { res.write(payload) } catch { set.delete(res) }
    }
  }

  /** Current runs projection for a workspace (against its config). */
  const runsNow = (workspaceId: string): Record<string, RunState> => {
    const config = store.get(workspaceId)
    return supervisor.runsOf(workspaceId, config.groups)
  }

  supervisor.on('state', (event: { workspaceId: string }) => {
    broadcast(event.workspaceId, { type: 'state', workspaceId: event.workspaceId, runs: runsNow(event.workspaceId) })
  })
  supervisor.on('output', (event: { workspaceId: string; chunk: OutputChunk }) => {
    broadcast(event.workspaceId, { type: 'output', workspaceId: event.workspaceId, chunk: event.chunk })
  })
  const configListeners: Array<() => void> = []

  const sse = (req: IncomingMessage, res: ServerResponse): void => {
    const workspaceId = queryWorkspace(req.url ?? '')
    if (workspaceId === undefined || workspaces.get(workspaceId) === undefined) {
      json(res, fail('invalid_input', '缺少或未知的 workspace 参数').res, 400)
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(':ok\n\n')
    // Initial state snapshot so a fresh tab shows something immediately.
    res.write(`data: ${JSON.stringify({ type: 'state', workspaceId, runs: runsNow(workspaceId) })}\n\n`)

    let set = subscribers.get(workspaceId)
    if (set === undefined) {
      set = new Set()
      subscribers.set(workspaceId, set)
    }
    set.add(res)

    const heartbeat = setInterval(() => {
      try { res.write(':hb\n\n') } catch { /* closed */ }
    }, HEARTBEAT_MS)

    req.on('close', () => {
      clearInterval(heartbeat)
      set?.delete(res)
    })
  }

  // -------------------------------------------------------------------------
  // Prefix handler
  // -------------------------------------------------------------------------
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = req.url ?? ''
      const path = url.split('?')[0] ?? url
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && path === '/dsh-devlaunch/state') {
        const workspaceId = queryWorkspace(url)
        if (workspaceId === undefined || workspaces.get(workspaceId) === undefined) {
          const { res: envelope, status } = fail('invalid_input', '缺少或未知的 workspace 参数')
          json(res, envelope, status)
          return
        }
        json(res, { ok: true, value: stateResponse(workspaceId) })
        return
      }

      if (method === 'POST' && path === '/dsh-devlaunch/config') {
        const body = await readBody(req)
        if (body === null) { const { res: envelope, status } = fail('invalid_input', '请求体不是合法 JSON'); json(res, envelope, status); return }
        const workspaceId = typeof body.workspace === 'string' ? body.workspace : undefined
        if (workspaceId === undefined || workspaces.get(workspaceId) === undefined) {
          const { res: envelope, status } = fail('invalid_input', '缺少或未知的 workspace'); json(res, envelope, status); return
        }
        try {
          const config = store.replaceWorkspace(workspaceId, body.config)
          broadcast(workspaceId, { type: 'config', workspaceId })
          // Run-state may need re-projection if groups changed.
          broadcast(workspaceId, { type: 'state', workspaceId, runs: runsNow(workspaceId) })
          json(res, { ok: true, value: config })
        } catch (error) {
          const { res: envelope, status } = fail('invalid_input', error instanceof Error ? error.message : String(error))
          json(res, envelope, status)
        }
        return
      }

      if (method === 'POST' && (path === '/dsh-devlaunch/start' || path === '/dsh-devlaunch/stop' || path === '/dsh-devlaunch/restart')) {
        const body = await readBody(req)
        if (body === null) { const { res: envelope, status } = fail('invalid_input', '请求体不是合法 JSON'); json(res, envelope, status); return }
        const workspaceId = typeof body.workspace === 'string' ? body.workspace : undefined
        if (workspaceId === undefined || workspaces.get(workspaceId) === undefined) {
          const { res: envelope, status } = fail('invalid_input', '缺少或未知的 workspace'); json(res, envelope, status); return
        }
        const action = path.endsWith('/start') ? 'start' : path.endsWith('/stop') ? 'stop' : 'restart'
        const groupIds = action === 'restart'
          ? (typeof body.group === 'string' ? [body.group] : undefined)
          : strArray(body, 'groupIds')
        if (action === 'restart' && groupIds === undefined) {
          const { res: envelope, status } = fail('invalid_input', 'restart 需要 group 参数'); json(res, envelope, status); return
        }
        const { groups, error } = resolveGroups(workspaceId, groupIds)
        if (error !== undefined) { const { res: envelope, status } = fail('not_found', error); json(res, envelope, status); return }

        const outcomes = groups.map(group => {
          const outcome = action === 'start'
            ? supervisor.start(workspaceId, group)
            : action === 'stop'
              ? supervisor.stop(workspaceId, group)
              : supervisor.restart(workspaceId, group)
          return { group: group.id, ...outcome }
        })
        json(res, { ok: true, value: { outcomes } })
        return
      }

      if (method === 'GET' && path === '/dsh-devlaunch/history') {
        const workspaceId = queryWorkspace(url)
        const group = queryParam(url, 'group')
        const afterSeq = Number.parseInt(queryParam(url, 'afterSeq') ?? '0', 10)
        if (workspaceId === undefined || group === undefined || !Number.isFinite(afterSeq)) {
          const { res: envelope, status } = fail('invalid_input', '缺少 workspace/group/afterSeq 参数'); json(res, envelope, status); return
        }
        json(res, { ok: true, value: { chunks: supervisor.historyAfter(workspaceId, group, afterSeq) } })
        return
      }

      if (method === 'GET' && path === '/dsh-devlaunch/package-scripts') {
        const workspaceId = queryWorkspace(url)
        const ws = workspaceId === undefined ? undefined : workspaces.get(workspaceId)
        if (ws === undefined) {
          const { res: envelope, status } = fail('invalid_input', '缺少或未知的 workspace'); json(res, envelope, status); return
        }
        // Root + subdirectory scan (monorepo-aware); failures degrade to an
        // empty suggestion list, never an error envelope.
        const rows = await scanPackageScripts(ws.path).catch(() => [])
        json(res, { ok: true, value: { scripts: rows } })
        return
      }

      const { res: envelope, status } = fail('not_found', `未知路由 ${method} ${path}`)
      json(res, envelope, status)
    } catch (error) {
      const { res: envelope, status } = fail('internal', error instanceof Error ? error.message : String(error))
      try { json(res, envelope, status) } catch { /* response gone */ }
    }
  }

  const disposeRoutes = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  const disposeStream = ctx.webServer.register({ kind: 'exact', path: STREAM_PATH, handler: sse })
  return () => {
    disposeRoutes()
    disposeStream()
    for (const set of subscribers.values()) {
      for (const res of set) { try { res.end() } catch { /* gone */ } }
      set.clear()
    }
    subscribers.clear()
    for (const off of configListeners.splice(0)) off()
  }
}
