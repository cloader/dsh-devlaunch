import { ConfigStore } from "./host/config.js";
import { registerDevlaunchRoutes } from "./host/routes.js";
import { ProcessSupervisor } from "./host/supervisor.js";
//#region src/index.ts
/** Cordis plugin name. */
const name = "dsh-devlaunch";
/** No hard service deps at the root: everything comes up with the workspace registry. */
const inject = [];
/**
* Mount the host half.
* @param ctx - the plugin context.
*/
function apply(ctx) {
	const store = new ConfigStore();
	ctx.inject(["workspaceRegistry"], (wsCtx) => {
		const supervisor = new ProcessSupervisor({ roots: { root(workspaceId) {
			try {
				const ws = wsCtx.workspaceRegistry.get(workspaceId);
				return ws === void 0 ? void 0 : ws.path;
			} catch {
				return;
			}
		} } });
		let disposeRoutes;
		wsCtx.inject(["webServer"], (webCtx) => {
			disposeRoutes = registerDevlaunchRoutes(webCtx, {
				store,
				supervisor,
				workspaces: {
					get: (id) => {
						const ws = wsCtx.workspaceRegistry.get(id);
						return ws === void 0 ? void 0 : {
							id: ws.id,
							path: ws.path,
							title: ws.title
						};
					},
					resolveByPath: async (path) => {
						const ws = await wsCtx.workspaceRegistry.resolveByPath(path);
						return ws === void 0 ? void 0 : { id: ws.id };
					}
				}
			});
			return () => disposeRoutes?.();
		});
		return () => {
			disposeRoutes?.();
			supervisor.dispose();
		};
	});
}
//#endregion
export { apply, inject, name };

//# sourceMappingURL=index.js.map