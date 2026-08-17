/**
 * Host loader entry for dsh-devlaunch.
 *
 * Wiring: the config store (one JSON file under the DSH home), the
 * ProcessSupervisor (spawn / tree-kill / ring buffer), and the
 * /dsh-devlaunch JSON+SSE routes (when a webServer is served).
 *
 * Export shape follows the dsh-tool-todo lesson: a function/namespace
 * plugin — `name` / `inject` / `apply`, NO default export. Zero runtime
 * @deepseek-ai imports (all type-only, vanish at compile time).
 *
 * @module dsh-devlaunch
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the workspaceRegistry Context merge (ctx.workspaceRegistry).
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: pulls the webServer Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ConfigStore } from './host/config.ts'
import { registerDevlaunchRoutes } from './host/routes.ts'
import { ProcessSupervisor } from './host/supervisor.ts'

/** Cordis plugin name. */
export const name = 'dsh-devlaunch'

/** No hard service deps at the root: everything comes up with the workspace registry. */
export const inject: string[] = []

/**
 * Mount the host half.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  const store = new ConfigStore()

  // Everything that touches workspace paths waits for the registry.
  ctx.inject(['workspaceRegistry'], (wsCtx: Context) => {
    const roots = {
      root(workspaceId: string): string | undefined {
        try {
          const ws = wsCtx.workspaceRegistry.get(workspaceId as never)
          return ws === undefined ? undefined : ws.path
        } catch {
          return undefined
        }
      },
    }
    const supervisor = new ProcessSupervisor({ roots })

    let disposeRoutes: (() => void) | undefined
    wsCtx.inject(['webServer'], (webCtx: Context) => {
      disposeRoutes = registerDevlaunchRoutes(webCtx, {
        store,
        supervisor,
        workspaces: {
          get: id => {
            const ws = wsCtx.workspaceRegistry.get(id as never)
            return ws === undefined ? undefined : { id: ws.id, path: ws.path, title: ws.title }
          },
          resolveByPath: async path => {
            const ws = await wsCtx.workspaceRegistry.resolveByPath(path as never)
            return ws === undefined ? undefined : { id: ws.id }
          },
        },
      })
      return () => disposeRoutes?.()
    })

    return () => {
      disposeRoutes?.()
      supervisor.dispose()
    }
  })
}
