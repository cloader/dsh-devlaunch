import { ROUTE_PREFIX, STREAM_PATH } from "../shared/api.js";
import { scanPackageScripts } from "./scanner.js";
//#region src/host/routes.ts
/** SSE heartbeat cadence. */
const HEARTBEAT_MS = 2e4;
/** JSON-envelope writer. */
function json(res, payload, status = 200) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(body);
}
/** Failure envelope + status. */
function fail(code, message) {
	return {
		res: {
			ok: false,
			error: {
				code,
				message
			}
		},
		status: code === "invalid_input" ? 400 : code === "not_found" ? 404 : 500
	};
}
/** Read one JSON body (null on parse failure). */
async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : null;
	} catch {
		return null;
	}
}
/** ?workspace=... extractor. */
function queryWorkspace(url) {
	const match = /[?&]workspace=([^&]+)/.exec(url ?? "");
	return match === null ? void 0 : decodeURIComponent(match[1]);
}
/** ?group=... / ?afterSeq=... extractors. */
function queryParam(url, key) {
	const match = new RegExp(`[?&]${key}=([^&]*)`).exec(url ?? "");
	return match === null ? void 0 : decodeURIComponent(match[1]);
}
/** String array field of a JSON body. */
function strArray(body, key) {
	const value = body[key];
	if (value === void 0) return void 0;
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const item of value) {
		if (typeof item !== "string") return void 0;
		out.push(item);
	}
	return out;
}
/**
* Register the routes. Returns a disposer.
*/
function registerDevlaunchRoutes(ctx, options) {
	const { store, supervisor, workspaces } = options;
	/** Resolve groups by id list, or default to enabled groups. */
	const resolveGroups = (workspaceId, groupIds) => {
		const config = store.get(workspaceId);
		if (groupIds === void 0) return { groups: config.groups.filter((g) => g.enabled) };
		const groups = [];
		for (const id of groupIds) {
			const group = config.groups.find((g) => g.id === id);
			if (group === void 0) return {
				groups: [],
				error: `未知启动组: ${id}`
			};
			groups.push(group);
		}
		return { groups };
	};
	/** Build the state response. */
	const stateResponse = (workspaceId) => {
		const config = store.get(workspaceId);
		const runs = supervisor.runsOf(workspaceId, config.groups);
		const seqByGroup = {};
		let hasHistory = false;
		for (const group of config.groups) {
			seqByGroup[group.id] = supervisor.seqOf(workspaceId, group.id);
			if (supervisor.hasHistoryFor(workspaceId, group.id)) hasHistory = true;
		}
		return {
			workspaceId,
			config,
			runs,
			seqByGroup,
			hasHistory
		};
	};
	/** Per-workspace subscriber sets. */
	const subscribers = /* @__PURE__ */ new Map();
	/** Broadcast a serialized event to one workspace's streams. */
	const broadcast = (workspaceId, event) => {
		const set = subscribers.get(workspaceId);
		if (set === void 0 || set.size === 0) return;
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const res of set) try {
			res.write(payload);
		} catch {
			set.delete(res);
		}
	};
	/** Current runs projection for a workspace (against its config). */
	const runsNow = (workspaceId) => {
		const config = store.get(workspaceId);
		return supervisor.runsOf(workspaceId, config.groups);
	};
	supervisor.on("state", (event) => {
		broadcast(event.workspaceId, {
			type: "state",
			workspaceId: event.workspaceId,
			runs: runsNow(event.workspaceId)
		});
	});
	supervisor.on("output", (event) => {
		broadcast(event.workspaceId, {
			type: "output",
			workspaceId: event.workspaceId,
			chunk: event.chunk
		});
	});
	const configListeners = [];
	const sse = (req, res) => {
		const workspaceId = queryWorkspace(req.url ?? "");
		if (workspaceId === void 0 || workspaces.get(workspaceId) === void 0) {
			json(res, fail("invalid_input", "缺少或未知的 workspace 参数").res, 400);
			return;
		}
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no"
		});
		res.write(":ok\n\n");
		res.write(`data: ${JSON.stringify({
			type: "state",
			workspaceId,
			runs: runsNow(workspaceId)
		})}\n\n`);
		let set = subscribers.get(workspaceId);
		if (set === void 0) {
			set = /* @__PURE__ */ new Set();
			subscribers.set(workspaceId, set);
		}
		set.add(res);
		const heartbeat = setInterval(() => {
			try {
				res.write(":hb\n\n");
			} catch {}
		}, HEARTBEAT_MS);
		req.on("close", () => {
			clearInterval(heartbeat);
			set?.delete(res);
		});
	};
	const handler = async (req, res) => {
		try {
			const url = req.url ?? "";
			const path = url.split("?")[0] ?? url;
			const method = (req.method ?? "GET").toUpperCase();
			if (method === "GET" && path === "/dsh-devlaunch/state") {
				const workspaceId = queryWorkspace(url);
				if (workspaceId === void 0 || workspaces.get(workspaceId) === void 0) {
					const { res: envelope, status } = fail("invalid_input", "缺少或未知的 workspace 参数");
					json(res, envelope, status);
					return;
				}
				json(res, {
					ok: true,
					value: stateResponse(workspaceId)
				});
				return;
			}
			if (method === "POST" && path === "/dsh-devlaunch/config") {
				const body = await readBody(req);
				if (body === null) {
					const { res: envelope, status } = fail("invalid_input", "请求体不是合法 JSON");
					json(res, envelope, status);
					return;
				}
				const workspaceId = typeof body.workspace === "string" ? body.workspace : void 0;
				if (workspaceId === void 0 || workspaces.get(workspaceId) === void 0) {
					const { res: envelope, status } = fail("invalid_input", "缺少或未知的 workspace");
					json(res, envelope, status);
					return;
				}
				try {
					const config = store.replaceWorkspace(workspaceId, body.config);
					broadcast(workspaceId, {
						type: "config",
						workspaceId
					});
					broadcast(workspaceId, {
						type: "state",
						workspaceId,
						runs: runsNow(workspaceId)
					});
					json(res, {
						ok: true,
						value: config
					});
				} catch (error) {
					const { res: envelope, status } = fail("invalid_input", error instanceof Error ? error.message : String(error));
					json(res, envelope, status);
				}
				return;
			}
			if (method === "POST" && (path === "/dsh-devlaunch/start" || path === "/dsh-devlaunch/stop" || path === "/dsh-devlaunch/restart")) {
				const body = await readBody(req);
				if (body === null) {
					const { res: envelope, status } = fail("invalid_input", "请求体不是合法 JSON");
					json(res, envelope, status);
					return;
				}
				const workspaceId = typeof body.workspace === "string" ? body.workspace : void 0;
				if (workspaceId === void 0 || workspaces.get(workspaceId) === void 0) {
					const { res: envelope, status } = fail("invalid_input", "缺少或未知的 workspace");
					json(res, envelope, status);
					return;
				}
				const action = path.endsWith("/start") ? "start" : path.endsWith("/stop") ? "stop" : "restart";
				const groupIds = action === "restart" ? typeof body.group === "string" ? [body.group] : void 0 : strArray(body, "groupIds");
				if (action === "restart" && groupIds === void 0) {
					const { res: envelope, status } = fail("invalid_input", "restart 需要 group 参数");
					json(res, envelope, status);
					return;
				}
				const { groups, error } = resolveGroups(workspaceId, groupIds);
				if (error !== void 0) {
					const { res: envelope, status } = fail("not_found", error);
					json(res, envelope, status);
					return;
				}
				json(res, {
					ok: true,
					value: { outcomes: groups.map((group) => {
						const outcome = action === "start" ? supervisor.start(workspaceId, group) : action === "stop" ? supervisor.stop(workspaceId, group) : supervisor.restart(workspaceId, group);
						return {
							group: group.id,
							...outcome
						};
					}) }
				});
				return;
			}
			if (method === "GET" && path === "/dsh-devlaunch/history") {
				const workspaceId = queryWorkspace(url);
				const group = queryParam(url, "group");
				const afterSeq = Number.parseInt(queryParam(url, "afterSeq") ?? "0", 10);
				if (workspaceId === void 0 || group === void 0 || !Number.isFinite(afterSeq)) {
					const { res: envelope, status } = fail("invalid_input", "缺少 workspace/group/afterSeq 参数");
					json(res, envelope, status);
					return;
				}
				json(res, {
					ok: true,
					value: { chunks: supervisor.historyAfter(workspaceId, group, afterSeq) }
				});
				return;
			}
			if (method === "GET" && path === "/dsh-devlaunch/package-scripts") {
				const workspaceId = queryWorkspace(url);
				const ws = workspaceId === void 0 ? void 0 : workspaces.get(workspaceId);
				if (ws === void 0) {
					const { res: envelope, status } = fail("invalid_input", "缺少或未知的 workspace");
					json(res, envelope, status);
					return;
				}
				json(res, {
					ok: true,
					value: { scripts: await scanPackageScripts(ws.path).catch(() => []) }
				});
				return;
			}
			const { res: envelope, status } = fail("not_found", `未知路由 ${method} ${path}`);
			json(res, envelope, status);
		} catch (error) {
			const { res: envelope, status } = fail("internal", error instanceof Error ? error.message : String(error));
			try {
				json(res, envelope, status);
			} catch {}
		}
	};
	const disposeRoutes = ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler
	});
	const disposeStream = ctx.webServer.register({
		kind: "exact",
		path: STREAM_PATH,
		handler: sse
	});
	return () => {
		disposeRoutes();
		disposeStream();
		for (const set of subscribers.values()) {
			for (const res of set) try {
				res.end();
			} catch {}
			set.clear();
		}
		subscribers.clear();
		for (const off of configListeners.splice(0)) off();
	};
}
//#endregion
export { registerDevlaunchRoutes };

//# sourceMappingURL=routes.js.map