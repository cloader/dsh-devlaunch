/**
 * LaunchButton: the session-header entry (slot conversation.session.header.actions).
 *
 * Compact split pill + dropdown: [▶ 启动 ▾]. When any group runs, the
 * main button becomes [● 停止(n)] with a pulsing green dot and a
 * stop-red hover; the dropdown lists each group with a status dot,
 * start/stop/restart icon actions, and the config entry point. With no
 * configured groups it degrades to a dashed "配置" affordance.
 *
 * @module dsh-devlaunch/client/launch-button
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type DevlaunchController, portConflicts, type WorkspaceView } from './controller.ts'
import type { LaunchGroup, RunState } from '../shared/protocol.ts'
import { IconChevron, IconGear, IconLayers, IconPlay, IconRestart, IconStop, IconTerminal } from './icons.tsx'

/** Props the slot runtime injects (session standard kit + our inject). */
export interface LaunchButtonProps {
  sessionId: string
  useSessions: <T>(selector: (state: any) => T) => T
  controller: DevlaunchController
  /** Resolve the workspace id of the current session (lazy). */
  resolveWorkspace: (sessionId: string) => string | undefined
}

/** Status dot color for a run state. */
function dotClass(run: RunState | undefined): string {
  if (run === undefined) return 'dl-dot dl-dot-off'
  if (run.status === 'running') return run.ready === true ? 'dl-dot dl-dot-ready' : 'dl-dot dl-dot-on'
  if (run.status === 'exited' && (run.exitCode ?? 0) !== 0) return 'dl-dot dl-dot-err'
  return 'dl-dot dl-dot-off'
}

/** Short status text. */
function statusText(run: RunState | undefined): string {
  if (run === undefined) return '未运行'
  if (run.status === 'running') {
    const base = run.ready === true ? '就绪' : '运行中'
    return (run.restarts ?? 0) > 0 ? `${base} · 已重启${run.restarts}` : base
  }
  if (run.error !== undefined) return run.error
  if (run.status === 'exited') {
    if (run.stoppedByUser) return '已停止'
    return `退出码 ${run.exitCode ?? '?'}`
  }
  return '未运行'
}

/** One dropdown row. */
function GroupRow(props: {
  group: LaunchGroup
  run: RunState | undefined
  running: boolean
  conflictPort: number | undefined
  onStart: () => void
  onStop: () => void
  onRestart: () => void
}): ReactNode {
  const { group, run, running, conflictPort } = props
  const status = statusText(run)
  return (
    <div
      className="dl-menu-row"
      data-running={running || undefined}
      data-conflict={conflictPort !== undefined || undefined}
    >
      <span className={dotClass(run)} />
      <span className="dl-kind" data-kind={group.kind}>{kindLabel(group.kind)}</span>
      <span className="dl-row-label" title={`${group.command}${group.cwd === '' ? '' : `  (${group.cwd})`}`}>{group.label}</span>
      {conflictPort !== undefined
        ? <span className="dl-restart-badge" title={`端口冲突：${conflictPort} 被多个运行中的组占用`}>⚠ :${conflictPort}</span>
        : null}
      <span className={run?.ready === true ? 'dl-row-status dl-status-ready' : 'dl-row-status'} title={status}>{status}</span>
      <span className="dl-row-actions">
        {running
          ? (
            <>
              <button type="button" className="dl-mini dl-mini-restart" title="重启" onClick={props.onRestart}><IconRestart size={13} /></button>
              <button type="button" className="dl-mini dl-mini-stop" title="停止" onClick={props.onStop}><IconStop size={11} /></button>
            </>
          )
          : (
            <button type="button" className="dl-mini dl-mini-go" title="启动" onClick={props.onStart}><IconPlay size={12} /></button>
          )}
      </span>
    </div>
  )
}

/** Kind chip text. */
function kindLabel(kind: string): string {
  if (kind === 'frontend') return '前端'
  if (kind === 'backend') return '后端'
  return '其他'
}

/** The header button component. */
export function LaunchButton(props: LaunchButtonProps): ReactNode {
  const { controller, sessionId, resolveWorkspace } = props

  // Workspace of this session (may be unresolved briefly after boot).
  const workspaceId = resolveWorkspace(sessionId)

  // Subscribe to controller changes (one shared snapshot per notify). The
  // snapshot folds in the preset selection so chip clicks re-render too.
  const version = useSyncExternalStore(
    useCallback((cb: () => void) => controller.subscribe(cb), [controller]),
    () => `${controllerVersion(controller, workspaceId)}:${workspaceId === undefined ? '' : controller.selectedProfile(workspaceId)}`,
  )
  const view: WorkspaceView | undefined = workspaceId === undefined ? undefined : controller.view(workspaceId)

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  // Acquire the workspace stream while mounted.
  useEffect(() => {
    if (workspaceId === undefined) return
    return controller.acquire(workspaceId)
  }, [controller, workspaceId])

  // Close the dropdown on outside pointerdown.
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [open])

  const groups = useMemo(() => view?.config.groups ?? [], [view])
  const profiles = useMemo(() => view?.config.profiles ?? [], [view])
  const runs = view?.runs ?? {}
  const runningCount = useMemo(
    () => groups.filter(group => (runs[group.id]?.status ?? 'stopped') === 'running').length,
    [groups, runs],
  )
  const hasGroups = groups.length > 0
  const conflicts = useMemo(() => portConflicts(runs), [runs])
  const profileSel = workspaceId === undefined ? '' : controller.selectedProfile(workspaceId)
  const target = workspaceId === undefined ? undefined : controller.profileTarget(workspaceId)
  const targetLabel = target?.profileId === '' ? '全部' : (target?.label ?? '全部')

  /** Run an action with busy/error handling. */
  const act = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    if (workspaceId === undefined) return
    setBusy(true)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [workspaceId])

  const mainAction = (): void => {
    if (!hasGroups) {
      setOpen(true)
      return
    }
    if (runningCount > 0) {
      void act(() => controller.stop(workspaceId!))
    } else {
      // Preset-aware start: selected profile groups + stop outsiders.
      void act(() => controller.startTarget(workspaceId!))
    }
  }

  const pillState = runningCount > 0 ? 'running' : hasGroups ? 'idle' : 'empty'
  const pillDisabled = busy || workspaceId === undefined

  // version keeps the closure fresh; eslint may complain about completeness.
  void version

  return (
    <div className="dl-root" ref={rootRef} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}>
      <div className={pillDisabled ? 'dl-pill dl-pill-disabled' : 'dl-pill'} data-state={pillState}>
        <button
          type="button"
          className="dl-trigger"
          aria-expanded={open}
          aria-label={runningCount > 0 ? `停止 ${runningCount} 个服务` : '一键启动'}
          title={workspaceId === undefined ? '正在解析项目…' : runningCount > 0 ? '一键停止' : `一键启动「${targetLabel}」`}
          disabled={busy || workspaceId === undefined}
          onClick={mainAction}
        >
          {runningCount > 0
            ? (
              <>
                <span className="dl-dot dl-dot-on" />
                <span>停止 {runningCount}</span>
              </>
            )
            : hasGroups
              ? (
                <>
                  <span className="dl-pill-ico"><IconPlay size={11} /></span>
                  <span>启动</span>
                </>
              )
              : (
                <>
                  <span className="dl-pill-ico"><IconGear size={12} /></span>
                  <span>启动配置</span>
                </>
              )}
        </button>
        <span className="dl-pill-div" />
        <button
          type="button"
          className="dl-caret-btn"
          aria-label="启动菜单"
          aria-expanded={open}
          disabled={workspaceId === undefined}
          onClick={() => { setOpen(current => !current) }}
        >
          <IconChevron size={12} className={open ? 'dl-caret-flip' : undefined} />
        </button>
      </div>
      {open
        ? (
          <div className="dl-menu" role="menu">
            <div className="dl-menu-head">
              <span className="dl-menu-title"><IconTerminal size={12} />启动组</span>
              <button
                type="button"
                className="dl-menu-config"
                onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('dsh-devlaunch:config', { detail: { workspaceId } })) }}
              >
                <IconGear size={11} />配置…
              </button>
            </div>
            {error !== undefined ? <div className="dl-menu-error" role="alert">{error}</div> : null}
            {profiles.length > 0
              ? (
                <div className="dl-profile-bar">
                  <span className="dl-profile-label"><IconLayers size={11} />预设</span>
                  <button
                    type="button"
                    className="dl-profile-chip"
                    data-on={profileSel === '' || undefined}
                    title="一键启动 = 全部启用的组"
                    onClick={() => { controller.setSelectedProfile(workspaceId!, '') }}
                  >
                    全部
                  </button>
                  {profiles.map(profile => (
                    <button
                      type="button"
                      key={profile.id}
                      className="dl-profile-chip"
                      data-on={profileSel === profile.id || undefined}
                      title={`一键启动 = ${profile.label}（${profile.groupIds.length} 组），并停止预设外的运行组`}
                      onClick={() => { controller.setSelectedProfile(workspaceId!, profile.id) }}
                    >
                      {profile.label}
                    </button>
                  ))}
                </div>
              )
              : null}
            {hasGroups
              ? groups.map(group => (
                <GroupRow
                  key={group.id}
                  group={group}
                  run={runs[group.id]}
                  running={(runs[group.id]?.status ?? 'stopped') === 'running'}
                  conflictPort={conflicts.get(group.id)}
                  onStart={() => { void act(() => controller.start(workspaceId!, [group.id])) }}
                  onStop={() => { void act(() => controller.stop(workspaceId!, [group.id])) }}
                  onRestart={() => { void act(() => controller.restart(workspaceId!, group.id)) }}
                />
              ))
              : (
                <div className="dl-menu-empty">
                  <IconTerminal size={22} />
                  <span>尚未配置启动命令。<br />点击「配置…」添加前端 / 后端命令。</span>
                  <button
                    type="button"
                    className="dl-rail-config"
                    onClick={() => { setOpen(false); window.dispatchEvent(new CustomEvent('dsh-devlaunch:config', { detail: { workspaceId } })) }}
                  >
                    <IconGear size={11} />去配置
                  </button>
                </div>
              )}
            {hasGroups
              ? (
                <div className="dl-menu-foot">
                  <button type="button" className="dl-foot-btn dl-foot-go" disabled={busy} onClick={() => { void act(() => controller.startTarget(workspaceId!)) }}>
                    <IconPlay size={10} />启动「{targetLabel}」
                  </button>
                  <button type="button" className="dl-foot-btn dl-foot-danger" disabled={busy || runningCount === 0} onClick={() => { void act(() => controller.stop(workspaceId!)) }}>
                    <IconStop size={9} />全部停止
                  </button>
                </div>
              )
              : null}
          </div>
        )
        : null}
    </div>
  )
}

/** Snapshot token for useSyncExternalStore (changes whenever the view does). */
function controllerVersion(controller: DevlaunchController, workspaceId: string | undefined): number {
  if (workspaceId === undefined) return 0
  const view = controller.view(workspaceId)
  if (view === undefined) return 0
  // Cheap monotone-ish token: line totals + run statuses hash.
  let hash = view.connected ? 1 : 0
  for (const run of Object.values(view.runs)) {
    hash = (hash * 31 + run.status.length + (run.exitCode ?? 0)) | 0
  }
  for (const lines of view.lines.values()) hash = (hash * 31 + lines.length) | 0
  hash = (hash * 31 + view.config.groups.length) | 0
  return hash
}
