/**
 * ConfigModal: the launch-config editor. Listens for the
 * 'dsh-devlaunch:config' window event (fired by the header button and the
 * console empty state), edits the workspace's groups, and saves them via
 * the controller. Includes one-click import suggestions from the
 * workspace's package.json scripts.
 *
 * Rendered as a single document-level React root (mounted by index.ts);
 * the modal itself is plain fixed-position DOM, no shell slots involved.
 *
 * @module dsh-devlaunch/client/config-modal
 */
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DevlaunchController } from './controller.ts'
import { type GroupKind, GROUP_KINDS, type LaunchGroup, type LaunchProfile, type ScriptSuggestion, newGroupId } from '../shared/protocol.ts'
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconClose,
  IconImport,
  IconLayers,
  IconPlus,
  IconTerminal,
} from './icons.tsx'

/** Editable draft of one group (looser than the wire type while editing). */
interface Draft {
  id: string
  kind: GroupKind
  label: string
  command: string
  cwd: string
  envText: string
  enabled: boolean
  readyUrlText: string
  autoRestart: boolean
}

/** Editable draft of one launch preset. */
interface ProfileDraft {
  id: string
  label: string
  members: string[]
}

/** Props. */
export interface ConfigModalProps {
  controller: DevlaunchController
}

/** Wire group → draft. */
function toDraft(group: LaunchGroup): Draft {
  return {
    id: group.id,
    kind: group.kind,
    label: group.label,
    command: group.command,
    cwd: group.cwd,
    envText: Object.entries(group.env).map(([k, v]) => `${k}=${v}`).join('\n'),
    enabled: group.enabled,
    readyUrlText: group.readyUrl ?? '',
    autoRestart: group.autoRestart === true,
  }
}

/** Fresh empty draft. */
function emptyDraft(kind: GroupKind): Draft {
  return { id: newGroupId(), kind, label: '', command: '', cwd: '', envText: '', enabled: true, readyUrlText: '', autoRestart: false }
}

/** Wire profile → draft. */
function profileToDraft(profile: LaunchProfile): ProfileDraft {
  return { id: profile.id, label: profile.label, members: [...profile.groupIds] }
}

/** Parse env text → record; throws on malformed lines. */
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) throw new Error(`环境变量格式应为 KEY=VALUE：${trimmed}`)
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
  }
  return env
}

/** Kind label. */
function kindLabel(kind: GroupKind): string {
  if (kind === 'frontend') return '前端'
  if (kind === 'backend') return '后端'
  return '其他'
}

/** The modal component (mounted once at the document level). */
export function ConfigModal(props: ConfigModalProps): ReactNode {
  const { controller } = props
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [profileDrafts, setProfileDrafts] = useState<ProfileDraft[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [suggests, setSuggests] = useState<ScriptSuggestion[]>([])
  const [showSuggests, setShowSuggests] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /** Open on the window event. */
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail
      if (detail?.workspaceId === undefined) return
      setWorkspaceId(detail.workspaceId)
      const view = controller.view(detail.workspaceId)
      setDrafts((view?.config.groups ?? []).map(toDraft))
      setProfileDrafts((view?.config.profiles ?? []).map(profileToDraft))
      setLoaded(false)
      setError(undefined)
      setShowSuggests(false)
    }
    window.addEventListener('dsh-devlaunch:config', onOpen)
    return () => { window.removeEventListener('dsh-devlaunch:config', onOpen) }
  }, [controller])

  /** Refresh config when opened (in case another tab edited it). */
  useEffect(() => {
    if (workspaceId === undefined || loaded) return
    void controller.refreshState(workspaceId).then(() => {
      const view = controller.view(workspaceId)
      setDrafts((view?.config.groups ?? []).map(toDraft))
      setProfileDrafts((view?.config.profiles ?? []).map(profileToDraft))
      setLoaded(true)
    })
  }, [controller, workspaceId, loaded])

  /** Close on Escape. */
  const close = useCallback((): void => {
    setWorkspaceId(undefined)
  }, [])

  /** Focus the first input on open. */
  useEffect(() => {
    if (workspaceId !== undefined) inputRef.current?.focus()
  }, [workspaceId])

  const update = (index: number, patch: Partial<Draft>): void => {
    setDrafts(current => current.map((d, i) => (i === index ? { ...d, ...patch } : d)))
  }

  const move = (index: number, delta: number): void => {
    setDrafts(current => {
      const next = [...current]
      const target = index + delta
      if (target < 0 || target >= next.length) return current
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item!)
      return next
    })
  }

  const save = async (): Promise<void> => {
    if (workspaceId === undefined) return
    setSaving(true)
    setError(undefined)
    try {
      const groups = drafts.map(draft => ({
        id: draft.id,
        kind: draft.kind,
        label: draft.label,
        command: draft.command,
        cwd: draft.cwd,
        env: parseEnv(draft.envText),
        enabled: draft.enabled,
        readyUrl: draft.readyUrlText.trim() === '' ? undefined : draft.readyUrlText.trim(),
        autoRestart: draft.autoRestart,
      }))
      const profiles = profileDrafts
        .filter(p => p.members.length > 0)
        .map(p => ({ id: p.id, label: p.label, groupIds: p.members }))
      await controller.saveConfig(workspaceId, { groups, profiles })
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const loadSuggests = async (): Promise<void> => {
    if (workspaceId === undefined) return
    setError(undefined)
    try {
      const scripts = await controller.packageScripts(workspaceId)
      setSuggests(scripts)
      setShowSuggests(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** Append one suggestion as a new draft (carrying the package's cwd). */
  const applySuggest = (suggestion: ScriptSuggestion): void => {
    // Subdirectory scripts get a dir-prefixed label so several packages'
    // 'dev' scripts stay distinguishable in the group list.
    const label = suggestion.cwd === ''
      ? suggestion.name
      : `${suggestion.cwd.split('/').at(-1) ?? suggestion.cwd}: ${suggestion.name}`
    setDrafts(current => [...current, { ...emptyDraft('other'), label, command: suggestion.command, cwd: suggestion.cwd }])
    setShowSuggests(false)
  }

  /** Patch one profile draft. */
  const updateProfile = (index: number, patch: Partial<ProfileDraft>): void => {
    setProfileDrafts(current => current.map((p, i) => (i === index ? { ...p, ...patch } : p)))
  }

  /** Toggle one group's membership in one profile. */
  const toggleMember = (index: number, groupId: string): void => {
    setProfileDrafts(current => current.map((p, i) => {
      if (i !== index) return p
      const members = p.members.includes(groupId)
        ? p.members.filter(id => id !== groupId)
        : [...p.members, groupId]
      return { ...p, members }
    }))
  }

  const kindCounts = useMemo(() => {
    const counts = { frontend: 0, backend: 0, other: 0 }
    for (const draft of drafts) counts[draft.kind] += 1
    return counts
  }, [drafts])

  if (workspaceId === undefined) return null

  return createPortal(
    <div className="dl-modal-scrim" onKeyDown={e => { if (e.key === 'Escape') close() }}>
      <div className="dl-modal" role="dialog" aria-label="启动配置">
        <div className="dl-modal-head">
          <span className="dl-modal-badge"><IconTerminal size={15} /></span>
          <div>
            <div className="dl-modal-title">启动配置</div>
            <div className="dl-modal-sub">前端 {kindCounts.frontend} · 后端 {kindCounts.backend} · 其他 {kindCounts.other}</div>
          </div>
          <button type="button" className="dl-modal-close" aria-label="关闭" onClick={close}><IconClose size={13} /></button>
        </div>
        <div className="dl-modal-body">
          {error !== undefined ? <div className="dl-menu-error" role="alert">{error}</div> : null}
          {drafts.map((draft, index) => (
            <div className="dl-form-row" data-kind={draft.kind} key={draft.id}>
              <div className="dl-form-line1">
                <select
                  className="dl-form-kind"
                  value={draft.kind}
                  onChange={e => { update(index, { kind: e.target.value as GroupKind }) }}
                  aria-label="类别"
                >
                  {GROUP_KINDS.map(kind => <option key={kind} value={kind}>{kindLabel(kind)}</option>)}
                </select>
                <input
                  ref={index === 0 ? inputRef : undefined}
                  className="dl-form-label"
                  value={draft.label}
                  placeholder="名称（如 前端 Vite）"
                  onChange={e => { update(index, { label: e.target.value }) }}
                />
                <label className="dl-switch" title="参与一键启动">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={e => { update(index, { enabled: e.target.checked }) }}
                  />
                  <span className="dl-switch-track" />
                  启用
                </label>
                <span className="dl-form-order">
                  <button type="button" className="dl-mini" title="上移" onClick={() => { move(index, -1) }}><IconArrowUp size={12} /></button>
                  <button type="button" className="dl-mini" title="下移" onClick={() => { move(index, 1) }}><IconArrowDown size={12} /></button>
                  <button type="button" className="dl-mini dl-mini-stop" title="删除" onClick={() => { setDrafts(current => current.filter((_, i) => i !== index)) }}><IconClose size={12} /></button>
                </span>
              </div>
              <input
                className="dl-form-command"
                value={draft.command}
                placeholder="命令（如 pnpm dev）"
                spellCheck={false}
                onChange={e => { update(index, { command: e.target.value }) }}
              />
              <div className="dl-form-line3">
                <input
                  className="dl-form-cwd"
                  value={draft.cwd}
                  placeholder="工作目录（相对项目根，可空）"
                  spellCheck={false}
                  onChange={e => { update(index, { cwd: e.target.value }) }}
                />
                <input
                  className="dl-form-cwd"
                  value={draft.readyUrlText}
                  placeholder="就绪检测 URL（可空，如 http://localhost:3000）"
                  spellCheck={false}
                  title="轮询该地址，任意 HTTP 响应即标记「就绪」"
                  onChange={e => { update(index, { readyUrlText: e.target.value }) }}
                />
              </div>
              <div className="dl-form-line4">
                <textarea
                  className="dl-form-env"
                  value={draft.envText}
                  placeholder={'环境变量 每行 KEY=VALUE（可空）'}
                  spellCheck={false}
                  rows={2}
                  onChange={e => { update(index, { envText: e.target.value }) }}
                />
                <label className="dl-form-opt dl-switch" title="异常退出后自动重启（指数退避，最多 5 次；手动停止不会触发）">
                  <input
                    type="checkbox"
                    checked={draft.autoRestart}
                    onChange={e => { update(index, { autoRestart: e.target.checked }) }}
                  />
                  <span className="dl-switch-track" />
                  崩溃自动重启
                </label>
              </div>
            </div>
          ))}
          <div className="dl-profiles-card">
            <div className="dl-profiles-head">
              <IconLayers size={13} />启动预设
              <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                一键启动可切换为预设组合，并自动停止预设外的运行组
              </span>
              <button type="button" className="dl-add-btn" onClick={() => { setProfileDrafts(current => [...current, { id: newGroupId(), label: '', members: [] }]) }}>
                <IconPlus size={11} />预设
              </button>
            </div>
            {profileDrafts.length === 0
              ? <div className="dl-profiles-empty">还没有预设。添加一个「仅前端」，一键启动时就只拉起选中的组。</div>
              : profileDrafts.map((profile, index) => (
                <div className="dl-profile-row" key={profile.id}>
                  <div className="dl-profile-line1">
                    <input
                      className="dl-profile-name"
                      value={profile.label}
                      placeholder="预设名（如 仅前端）"
                      onChange={e => { updateProfile(index, { label: e.target.value }) }}
                    />
                    <span className="dl-form-order">
                      <button type="button" className="dl-mini dl-mini-stop" title="删除预设" onClick={() => { setProfileDrafts(current => current.filter((_, i) => i !== index)) }}><IconClose size={12} /></button>
                    </span>
                  </div>
                  <div className="dl-profile-members">
                    {drafts.length === 0
                      ? <span className="dl-profiles-empty">先添加启动组</span>
                      : drafts.map(draft => (
                        <button
                          type="button"
                          key={draft.id}
                          className="dl-member-chip"
                          data-on={profile.members.includes(draft.id) || undefined}
                          onClick={() => { toggleMember(index, draft.id) }}
                        >
                          {draft.label === '' ? draft.id : draft.label}
                        </button>
                      ))}
                  </div>
                </div>
              ))}
          </div>
          <div className="dl-form-adds">
            <button type="button" className="dl-add-btn" data-kind="frontend" onClick={() => { setDrafts(current => [...current, emptyDraft('frontend')]) }}><IconPlus size={11} />前端</button>
            <button type="button" className="dl-add-btn" data-kind="backend" onClick={() => { setDrafts(current => [...current, emptyDraft('backend')]) }}><IconPlus size={11} />后端</button>
            <button type="button" className="dl-add-btn" data-kind="other" onClick={() => { setDrafts(current => [...current, emptyDraft('other')]) }}><IconPlus size={11} />其他</button>
            <button type="button" className="dl-add-btn" data-import="" onClick={() => { void loadSuggests() }}><IconImport size={12} />从 package.json 导入</button>
          </div>
          {showSuggests
            ? (
              <div className="dl-suggest">
                <div className="dl-suggest-head">
                  <span>package.json scripts（含子目录）</span>
                  <button type="button" className="dl-mini" onClick={() => { setShowSuggests(false) }}><IconClose size={12} /></button>
                </div>
                {suggests.length === 0
                  ? <div className="dl-suggest-empty">项目内没有找到 package.json scripts</div>
                  : suggests.map(s => (
                    <button type="button" key={`${s.cwd}/${s.name}`} className="dl-suggest-row" onClick={() => { applySuggest(s) }} title={s.cwd === '' ? s.command : `${s.cwd} → ${s.command}`}>
                      {s.cwd === ''
                        ? null
                        : <code className="dl-suggest-cwd">{s.cwd}</code>}
                      <code className="dl-suggest-name">{s.name}</code>
                      <code className="dl-suggest-cmd">{s.command}</code>
                      <span className="dl-suggest-add"><IconPlus size={10} />添加</span>
                    </button>
                  ))}
              </div>
            )
            : null}
        </div>
        <div className="dl-modal-foot">
          <span className="dl-modal-note">配置按项目保存，同项目的所有会话共享。</span>
          <button type="button" className="dl-foot-btn" onClick={close}>取消</button>
          <button type="button" className="dl-foot-btn dl-foot-go" disabled={saving} onClick={() => { void save() }}>
            {saving ? '保存中…' : <><IconCheck size={12} />保存</>}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
