/**
 * Browser half entry for dsh-devlaunch: wires the controller (one per page,
 * workspace-scoped SSE), resolves the session→workspace mapping through the
 * runtime's sessions/workspaces services (lazily — services may appear
 * after apply), and registers the three UI contributions:
 *
 * - conversation.session.header.actions → the ▶ 启动 button
 * - conversation.view (id dev-console)     → the console tab
 * - a document-level ConfigModal portal
 *
 * Failure policy follows the family precedent: DOM/slot problems are logged
 * and degrade only this plugin, never the GUI boot.
 *
 * @module dsh-devlaunch/client
 */
import { type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DevlaunchController } from './controller.ts'
import { injectStyles } from './styles.ts'
import { ConfigModal } from './config-modal.tsx'
import { ConsoleView } from './console-view.tsx'
import { LaunchButton } from './launch-button.tsx'

/** Client plugin name. */
export const name = 'dsh-devlaunch/client'

/** Required services (fiber inject waiting): slots for registration + sessions for the workspace map. */
export const inject = ['slots', 'sessions']

/** Narrow sessions service face (list mirror). */
interface SessionsFace {
  list: {
    getSnapshot(): {
      byId: Record<string, { cwd?: string } | undefined>
      current?: string
    }
  }
}

/** Effect-hook face the runner provides on the client context. */
interface ClientContextFace {
  get?(name: string): unknown
  effect?(fn: () => unknown, label?: string): void
}

/** Mount the client half. */
export function apply(ctx: ClientContextFace): void {
  try {
    injectStyles()
    const controller = new DevlaunchController()

    // Lazy session→workspace resolution. Sessions of a workspace are listed
    // under the workspace service; but the cheap universal source is the
    // sessions mirror itself: every listed session carries its cwd, and the
    // workspaces service maps workspaceId → sessionIds. We prefer the
    // workspaces service (exact ids), falling back to asking the host via
    // resolveByPath through... not available client-side; instead we use the
    // workspace lookup the runtime already maintains.
    const sessions = (): SessionsFace | undefined => ctx.get?.('sessions') as SessionsFace | undefined
    const workspaces = (): WorkspacesFace | undefined => ctx.get?.('workspaces') as WorkspacesFace | undefined

    /** Resolve the workspace id owning a session, lazily per render. */
    const resolveWorkspace = (sessionId: string): string | undefined => {
      // Fast path: the workspaces service lists workspaceId → sessionIds.
      const ws = workspaces()
      if (ws !== undefined) {
        try {
          const snapshot = ws.list.getSnapshot()
          const items = (snapshot as { items?: Array<{ workspaceId: string; sessionIds: readonly string[] }> }).items
          if (Array.isArray(items)) {
            for (const item of items) {
              if (item.sessionIds.includes(sessionId)) return item.workspaceId
            }
          }
        } catch { /* fall through */ }
      }
      return undefined
    }

    // The button and the console share the same resolution + controller.
    const slots = ctx.get?.('slots') as SlotsFace | undefined
    if (slots !== undefined) {
      // Header button.
      slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: 'devlaunch-button',
        order: 30,
        inject: () => ({
          controller,
          resolveWorkspace,
        }),
      }, LaunchButton as never))

      // Console view tab. Chat is order 0; ours sits after it.
      slots.inject('conversation.view', () => slots.register({
        name: 'conversation.view',
        id: 'dev-console',
        order: 10,
        label: () => '控制台',
        inject: (sessionId: string | undefined) => ({
          controller,
          resolveWorkspace,
          sessionId,
        }),
      }, ConsoleView as never))
    }

    // Document-level config modal (React portal, one root).
    let modalRoot: Root | undefined
    const host = document.createElement('div')
    host.dataset.dshDevlaunchModal = ''
    document.body.appendChild(host)
    modalRoot = createRoot(host)
    modalRoot.render(<ConfigModal controller={controller} />)

    // cordis effect semantics: the callback runs immediately and its RETURN
    // VALUE is the disposer.
    ctx.effect?.(() => () => {
      modalRoot?.unmount()
      host.remove()
      controller.dispose()
    }, 'dsh-devlaunch: client mount')
  } catch (error) {
    console.error('[dsh-devlaunch] client half failed to start:', error)
  }
}

/** Narrow workspaces service face. */
interface WorkspacesFace {
  list: {
    getSnapshot(): unknown
  }
}

/** Narrow slots service face. */
interface SlotsFace {
  inject(slot: string, factory: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}
