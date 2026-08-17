/**
 * ConsoleView: the in-session tab (slot conversation.view, id dev-console).
 *
 * Layout: left rail of groups (status dots + durations, plus all-start /
 * all-stop) and a terminal-styled main output pane for the selected
 * group. The toolbar carries start/stop/restart/copy/clear icon actions,
 * a live substring search with match highlighting, and an errors-only
 * filter. Output auto-scrolls unless the user scrolls up; ANSI escape
 * sequences are stripped for rendering (stderr keeps a red tint).
 *
 * @module dsh-devlaunch/client/console-view
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { type ConsoleLine, type DevlaunchController, portConflicts, type WorkspaceView } from './controller.ts'
import type { LaunchGroup, RunState } from '../shared/protocol.ts'
import {
  IconCheck,
  IconCopy,
  IconExport,
  IconFunnel,
  IconGear,
  IconPlay,
  IconRestart,
  IconSearch,
  IconStop,
  IconTerminal,
  IconTrash,
} from './icons.tsx'

/** Props the slot runtime injects. */
export interface ConsoleViewProps {
  sessionId: string
  useSessions: <T>(selector: (state: any) => T) => T
  controller: DevlaunchController
  resolveWorkspace: (sessionId: string) => string | undefined
}

/** Strip ANSI CSI/OSC sequences for plain rendering. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
}

/** Duration text for a running process. */
function durationText(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return ''
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

/** Kind label. */
function kindLabel(kind: string): string {
  if (kind === 'frontend') return '前端'
  if (kind === 'backend') return '后端'
  return '其他'
}

/** Status dot class. */
function dotClass(run: RunState | undefined): string {
  if (run?.status === 'running') return run.ready === true ? 'dl-dot dl-dot-ready' : 'dl-dot dl-dot-on'
  if (run?.status === 'exited' && (run.exitCode ?? 0) !== 0) return 'dl-dot dl-dot-err'
  return 'dl-dot dl-dot-off'
}

/** Render text with the first search match highlighted (case-insensitive). */
function Highlight(props: { text: string; query: string }): ReactNode {
  const { text, query } = props
  if (query === '') return <>{text}</>
  const index = text.toLowerCase().indexOf(query)
  if (index < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, index)}
      <mark className="dl-mark">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}

/** One rendered output line. */
function Line(props: { line: ConsoleLine; query: string }): ReactNode {
  const text = stripAnsi(props.line.text)
  return (
    <div className={props.line.stream === 'err' ? 'dl-line dl-line-err' : 'dl-line'}>
      <span className="dl-line-seq">{props.line.seq}</span>
      <span className="dl-line-text"><Highlight text={text} query={props.query} /></span>
    </div>
  )
}

/** The console view component. */
export function ConsoleView(props: ConsoleViewProps): ReactNode {
  const { controller, sessionId, resolveWorkspace } = props
  const workspaceId = resolveWorkspace(sessionId)

  const version = useSyncExternalStore(
    useCallback((cb: () => void) => controller.subscribe(cb), [controller]),
    () => consoleVersion(controller, workspaceId),
  )
  const view: WorkspaceView | undefined = workspaceId === undefined ? undefined : controller.view(workspaceId)

  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [follow, setFollow] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const [query, setQuery] = useState('')
  const [errOnly, setErrOnly] = useState(false)
  const [copied, setCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (workspaceId === undefined) return
    return controller.acquire(workspaceId)
  }, [controller, workspaceId])

  const groups = useMemo(() => view?.config.groups ?? [], [view])
  const runs = view?.runs ?? {}
  const runningCount = useMemo(
    () => groups.filter(group => (runs[group.id]?.status ?? 'stopped') === 'running').length,
    [groups, runs],
  )

  // Default selection: first group.
  const effectiveSelected = selected !== undefined && groups.some(g => g.id === selected)
    ? selected
    : groups[0]?.id
  const lines = useMemo(
    () => (workspaceId === undefined || effectiveSelected === undefined ? [] : view?.lines.get(effectiveSelected) ?? []),
    [view, effectiveSelected, workspaceId],
  )

  const normalizedQuery = query.trim().toLowerCase()
  const filtering = normalizedQuery !== '' || errOnly
  const visible = useMemo(() => {
    if (!filtering) return lines
    return lines.filter(line =>
      (!errOnly || line.stream === 'err')
      && (normalizedQuery === '' || stripAnsi(line.text).toLowerCase().includes(normalizedQuery)),
    )
  }, [lines, filtering, errOnly, normalizedQuery])

  // Tick for durations.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [])

  // Follow scroll.
  useEffect(() => {
    if (!follow) return
    const el = scrollRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [follow, visible.length, version])

  // Selection change resets follow + filters.
  useEffect(() => {
    setFollow(true)
    setQuery('')
    setErrOnly(false)
  }, [effectiveSelected])

  /** Detect user scroll away from the bottom. */
  const onScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  const selectedGroup = groups.find(g => g.id === effectiveSelected)
  const selectedRun = effectiveSelected === undefined ? undefined : runs[effectiveSelected]
  const conflicts = useMemo(() => portConflicts(runs), [runs])

  /** Copy the visible (filtered) output to the clipboard. */
  const copyOutput = useCallback((): void => {
    if (visible.length === 0) return
    if (navigator.clipboard === undefined) return
    const text = visible.map(l => stripAnsi(l.text)).join('\n')
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1500)
      },
      () => { /* clipboard denied: no-op */ },
    )
  }, [visible])

  /** Download the visible (filtered) output as a .log file. */
  const exportOutput = useCallback((): void => {
    if (selectedGroup === undefined || visible.length === 0) return
    const header = [
      `# devlaunch export — ${selectedGroup.label}`,
      `# command: ${selectedGroup.command}`,
      `# exported: ${new Date().toISOString()}`,
      `# lines: ${visible.length}`,
      '',
    ].join('\n')
    const body = visible.map(l => `[${l.stream === 'err' ? 'err' : 'out'}] ${stripAnsi(l.text)}`).join('\n')
    const blob = new Blob([header + body + '\n'], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const slug = selectedGroup.label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    anchor.href = url
    anchor.download = `${slug === '' ? 'devlaunch' : slug}.log`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  }, [selectedGroup, visible])

  /** Act with silent error swallow (console already shows state). */
  const act = useCallback((fn: () => Promise<unknown>): void => {
    if (workspaceId === undefined) return
    void fn().catch(() => {})
  }, [workspaceId])

  const connected = view?.connected ?? false

  const restartSuffix = (selectedRun?.restarts ?? 0) > 0 ? ` · 已重启${selectedRun?.restarts}` : ''
  const chip = selectedRun?.status === 'running'
    ? {
        state: 'running',
        text: (selectedRun.ready === true ? '已就绪' : '运行中')
          + ` · ${durationText(selectedRun.startedAt, now)}${restartSuffix}`,
      }
    : selectedRun?.status === 'exited' && ((selectedRun.exitCode ?? 0) !== 0 || selectedRun.error !== undefined)
      ? { state: 'error', text: selectedRun.error ?? (selectedRun.stoppedByUser ? '已停止' : `退出码 ${selectedRun.exitCode ?? '?'}`) }
      : { state: 'idle', text: selectedRun?.status === 'exited' ? '已停止' : '未运行' }
  const selectedPorts = selectedRun?.ports ?? []
  const selectedConflictPort = effectiveSelected === undefined ? undefined : conflicts.get(effectiveSelected)

  return (
    <div className="dl-console-root">
      <div className="dl-console-rail">
        <div className="dl-rail-head">
          <span>启动组</span>
          <span className={connected ? 'dl-conn dl-conn-on' : 'dl-conn'} title={connected ? '已连接' : '未连接'}>●</span>
        </div>
        <div className="dl-rail-list" role="tablist" aria-label="启动组">
          {groups.length === 0
            ? (
              <div className="dl-rail-empty">
                <IconTerminal size={22} />
                <span>尚未配置启动命令</span>
                <button
                  type="button"
                  className="dl-rail-config"
                  onClick={() => { window.dispatchEvent(new CustomEvent('dsh-devlaunch:config', { detail: { workspaceId } })) }}
                >
                  <IconGear size={11} />去配置
                </button>
              </div>
            )
            : groups.map(group => {
              const run = runs[group.id]
              const running = run?.status === 'running'
              return (
                <button
                  type="button"
                  key={group.id}
                  role="tab"
                  aria-selected={group.id === effectiveSelected}
                  className={group.id === effectiveSelected ? 'dl-rail-item dl-rail-item-on' : 'dl-rail-item'}
                  data-conflict={conflicts.get(group.id) !== undefined || undefined}
                  title={conflicts.get(group.id) !== undefined ? `端口冲突：${conflicts.get(group.id)} 被多个运行中的组占用` : undefined}
                  onClick={() => { setSelected(group.id) }}
                >
                  <span className={dotClass(run)} />
                  <span className="dl-kind" data-kind={group.kind}>{kindLabel(group.kind)}</span>
                  <span className="dl-rail-label">{group.label}</span>
                  {(run?.restarts ?? 0) > 0
                    ? <span className="dl-restart-badge" title={`异常退出后已自动重启 ${run?.restarts} 次`}>↻${run?.restarts}</span>
                    : null}
                  {running
                    ? <span className={run?.ready === true ? 'dl-rail-dur dl-rail-dur-run' : 'dl-rail-dur'}>{run?.ready === true ? '✓ ' : ''}{durationText(run?.startedAt, now)}</span>
                    : run?.status === 'exited' && (run.exitCode ?? 0) !== 0
                      ? <span className="dl-rail-dur dl-rail-dur-err" title={run.error ?? ''}>异常</span>
                      : null}
                </button>
              )
            })}
        </div>
        {groups.length > 0
          ? (
            <div className="dl-rail-foot">
              <button
                type="button"
                className="dl-rail-foot-btn dl-rail-foot-go"
                onClick={() => { act(() => controller.start(workspaceId!)) }}
                title="启动全部启用的组"
              >
                <IconPlay size={9} />全部启动
              </button>
              <button
                type="button"
                className="dl-rail-foot-btn dl-rail-foot-stop"
                disabled={runningCount === 0}
                onClick={() => { act(() => controller.stop(workspaceId!)) }}
                title="停止全部运行中的组"
              >
                <IconStop size={8} />全部停止
              </button>
            </div>
          )
          : null}
      </div>
      <div className="dl-console-main">
        {selectedGroup === undefined
          ? <div className="dl-console-empty"><IconTerminal size={26} />选择左侧启动组查看输出</div>
          : (
            <>
              <div className="dl-console-bar">
                <span className="dl-console-title">{selectedGroup.label}</span>
                <code className="dl-console-cmd" title={selectedGroup.command}>{selectedGroup.command}</code>
                {selectedGroup.cwd !== '' ? <code className="dl-console-cwd">{selectedGroup.cwd}</code> : null}
                <span className="dl-chip" data-state={chip.state}>
                  <span className={dotClass(selectedRun)} />{chip.text}
                </span>
                {selectedPorts.length > 0
                  ? (
                    <span className="dl-ports">
                      {selectedPorts.slice(0, 4).map(port => (
                        <a
                          key={port}
                          className="dl-port-chip"
                          href={`http://localhost:${port}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          data-conflict={selectedConflictPort === port || undefined}
                          title={selectedConflictPort === port ? `端口冲突：${port} 被多个运行中的组占用` : `打开 http://localhost:${port}`}
                        >
                          :${port}↗</a>
                      ))}
                    </span>
                  )
                  : null}
                <span className="dl-console-actions">
                  <button type="button" className="dl-mini dl-mini-go" disabled={selectedRun?.status === 'running'} onClick={() => { act(() => controller.start(workspaceId!, [selectedGroup.id])) }} title="启动"><IconPlay size={12} /></button>
                  <button type="button" className="dl-mini dl-mini-stop" disabled={selectedRun?.status !== 'running'} onClick={() => { act(() => controller.stop(workspaceId!, [selectedGroup.id])) }} title="停止"><IconStop size={10} /></button>
                  <button type="button" className="dl-mini dl-mini-restart" onClick={() => { act(() => controller.restart(workspaceId!, selectedGroup.id)) }} title="重启"><IconRestart size={13} /></button>
                  <button type="button" className={copied ? 'dl-mini dl-mini-copy dl-mini-copy-done' : 'dl-mini dl-mini-copy'} disabled={visible.length === 0} onClick={copyOutput} title={copied ? '已复制' : '复制输出'}>
                    {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                  </button>
                  <button type="button" className="dl-mini dl-mini-copy" disabled={visible.length === 0} onClick={exportOutput} title="导出为 .log 文件"><IconExport size={13} /></button>
                  <button type="button" className="dl-mini" disabled={lines.length === 0} onClick={() => { controller.clearLines(workspaceId!, selectedGroup.id) }} title="清屏"><IconTrash size={13} /></button>
                </span>
                <button
                  type="button"
                  className="dl-toggle-btn"
                  aria-pressed={errOnly}
                  title="只显示 stderr 输出"
                  onClick={() => { setErrOnly(current => !current) }}
                >
                  <IconFunnel size={11} />仅错误
                </button>
                <span className="dl-search-wrap">
                  <IconSearch size={12} />
                  <input
                    className="dl-search"
                    value={query}
                    placeholder="搜索输出…"
                    spellCheck={false}
                    onChange={e => { setQuery(e.target.value) }}
                    onKeyDown={e => { if (e.key === 'Escape') setQuery('') } }
                  />
                </span>
                {filtering
                  ? <span className="dl-filter-count" title="过滤后 / 总行数">{visible.length}/{lines.length} 行</span>
                  : null}
              </div>
              <div className="dl-console-scroll" ref={scrollRef} onScroll={onScroll}>
                {visible.length === 0
                  ? (
                    <div className="dl-console-nooutput">
                      <IconTerminal size={24} />
                      <span>{filtering ? '没有匹配的输出' : '暂无输出'}</span>
                    </div>
                  )
                  : visible.map(line => <Line key={line.seq} line={line} query={normalizedQuery} />)}
              </div>
              {!follow
                ? (
                  <button
                    type="button"
                    className="dl-follow-btn"
                    onClick={() => { setFollow(true) }}
                  >
                    ↓ 回到底部
                  </button>
                )
                : null}
            </>
          )}
      </div>
    </div>
  )
}

/** Snapshot token for the console view. */
function consoleVersion(controller: DevlaunchController, workspaceId: string | undefined): number {
  if (workspaceId === undefined) return 0
  const view = controller.view(workspaceId)
  if (view === undefined) return 0
  let hash = view.connected ? 7 : 0
  for (const run of Object.values(view.runs)) {
    hash = (hash * 31 + run.status.length + (run.exitCode ?? 0)) | 0
  }
  for (const lines of view.lines.values()) hash = (hash * 31 + lines.length) | 0
  hash = (hash * 31 + view.config.groups.length * 17) | 0
  return hash
}
