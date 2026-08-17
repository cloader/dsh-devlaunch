import { isWindows, killTree } from "./platform.js";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
//#region src/host/supervisor.ts
/**
* ProcessSupervisor: spawns user-configured launch commands, supervises
* them, ring-buffers their merged output, and emits events for the SSE
* routes. One instance per host process; keyed by (workspaceId, groupId).
*
* Windows specifics (the hard part, see devlaunch-analysis.md §4):
* - npm/pnpm are shell → cmd → node chains: `shell: true` is mandatory for
*   the command line itself, and stopping must kill the WHOLE tree via
*   `taskkill /PID <pid> /T /F`. Plain child.kill() only kills cmd.exe and
*   orphans the real server.
* - Output decoding is best-effort utf8: dev servers overwhelmingly emit
*   utf8 (or ANSI); a mangled multibyte boundary degrades one line, never
*   crashes the stream.
*
* Event fan-out: subscribers receive run-state changes and output batches.
* The routes layer turns subscriptions into SSE streams; the supervisor
* itself knows nothing about HTTP.
*
* @module dsh-devlaunch/host/supervisor
*/
/** Real spawn deps over node:child_process. */
function realSpawnDeps() {
	return {
		spawn: (command, options) => spawn(command, options),
		now: () => Date.now(),
		killGraceMs: () => 3e3
	};
}
/** Readiness probe cadence while a readyUrl group runs. */
const READY_POLL_MS = 1500;
/** Single readiness probe timeout (aborts, next tick retries). */
const READY_TIMEOUT_MS = 2500;
/** Auto-restart first delay; doubles per consecutive failure. */
const AUTO_RESTART_BASE_MS = 2e3;
/** Auto-restart backoff ceiling. */
const AUTO_RESTART_MAX_MS = 3e4;
/** Give up auto-restarting after this many consecutive failures. */
const AUTO_RESTART_MAX = 5;
/** A run that stayed up this long resets the backoff series. */
const AUTO_RESET_UPTIME_MS = 3e4;
/** Max distinct ports tracked per run. */
const MAX_PORTS = 8;
/** localhost-ish host:port forms in process output ("http://localhost:5173", "0.0.0.0:3000"…). */
const PORT_RE = /\b(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;
/**
* The supervisor. All public methods are synchronous-fast; process events
* arrive on the emitter.
*/
var ProcessSupervisor = class extends EventEmitter {
	procs = /* @__PURE__ */ new Map();
	roots;
	deps;
	maxHistoryLines;
	shuttingDown = false;
	constructor(options) {
		super();
		this.roots = options.roots;
		this.deps = options.deps ?? realSpawnDeps();
		this.maxHistoryLines = options.maxHistoryLines ?? 2e3;
	}
	/** Map key for a group. */
	key(workspaceId, groupId) {
		return `${workspaceId}::${groupId}`;
	}
	/** Proc lookup, creating the remembered slot on demand. */
	ensure(workspaceId, group) {
		const key = this.key(workspaceId, group.id);
		let proc = this.procs.get(key);
		if (proc === void 0) {
			proc = {
				workspaceId,
				group,
				child: void 0,
				status: "stopped",
				stoppedByUser: false,
				respawnOnClose: false,
				ready: false,
				restarts: 0,
				ports: [],
				history: [],
				historyBytes: 0,
				nextSeq: 1,
				pending: {
					out: "",
					err: ""
				}
			};
			this.procs.set(key, proc);
		} else proc.group = group;
		return proc;
	}
	/** Run-state projection for one workspace (all known groups). */
	runsOf(workspaceId, groups) {
		const runs = {};
		for (const group of groups) {
			const proc = this.procs.get(this.key(workspaceId, group.id));
			runs[group.id] = proc === void 0 ? { status: "stopped" } : this.projectRun(proc);
		}
		return runs;
	}
	/** Project one proc to its wire run state. */
	projectRun(proc) {
		const state = { status: proc.status };
		if (proc.pid !== void 0) state.pid = proc.pid;
		if (proc.startedAt !== void 0) state.startedAt = proc.startedAt;
		if (proc.exitedAt !== void 0) state.exitedAt = proc.exitedAt;
		if (proc.exitCode !== void 0) state.exitCode = proc.exitCode;
		if (proc.stoppedByUser) state.stoppedByUser = true;
		if (proc.error !== void 0) state.error = proc.error;
		if (proc.ready) state.ready = true;
		if (proc.restarts > 0) state.restarts = proc.restarts;
		if (proc.ports.length > 0) state.ports = [...proc.ports];
		return state;
	}
	/** Is the group currently running? */
	isRunning(workspaceId, groupId) {
		return this.procs.get(this.key(workspaceId, groupId))?.status === "running";
	}
	/**
	* Start one group. Idempotent: a running group is reported as skipped.
	* options.preserveRestarts keeps the auto-restart backoff series
	* (internal respawns only — a manual start always resets the counter).
	* Returns a per-group outcome.
	*/
	start(workspaceId, group, options = {}) {
		if (this.shuttingDown) return {
			ok: false,
			detail: "host 正在关闭"
		};
		const proc = this.ensure(workspaceId, group);
		if (proc.status === "running") return {
			ok: false,
			detail: "已在运行"
		};
		const root = this.roots.root(workspaceId);
		if (root === void 0) return {
			ok: false,
			detail: "项目根目录未知（workspace 尚未挂载？）"
		};
		const cwd = group.cwd === "" ? root : joinPath(root, group.cwd);
		const env = {
			...processEnv(),
			...group.env
		};
		this.clearAutoTimer(proc);
		proc.stoppedByUser = false;
		proc.respawnOnClose = false;
		proc.error = void 0;
		proc.exitCode = void 0;
		proc.exitedAt = void 0;
		proc.child = void 0;
		proc.pending = {
			out: "",
			err: ""
		};
		proc.nextSeq = 1;
		proc.history = [];
		proc.historyBytes = 0;
		proc.ready = false;
		proc.ports = [];
		if (options.preserveRestarts !== true) proc.restarts = 0;
		let child;
		try {
			child = this.deps.spawn(group.command, {
				cwd,
				env,
				shell: true
			});
		} catch (error) {
			proc.status = "exited";
			proc.error = `无法启动: ${errorMessage(error)}`;
			this.emitState(workspaceId, proc);
			return {
				ok: false,
				detail: proc.error
			};
		}
		proc.child = child;
		proc.status = "running";
		proc.startedAt = this.deps.now();
		proc.pid = child.pid;
		child.on("error", (error) => {
			if (proc.status !== "running") return;
			proc.status = "exited";
			proc.exitedAt = this.deps.now();
			proc.error = `启动失败: ${errorMessage(error)}`;
			this.emitState(workspaceId, proc);
		});
		child.stdout?.on("data", (buf) => this.ingest(workspaceId, proc, buf, "out"));
		child.stderr?.on("data", (buf) => this.ingest(workspaceId, proc, buf, "err"));
		this.startReadinessPoll(workspaceId, proc);
		child.on("close", (code) => {
			this.flushPending(workspaceId, proc, "out");
			this.flushPending(workspaceId, proc, "err");
			this.stopReadinessPoll(proc);
			proc.ready = false;
			if (proc.status !== "running") return;
			proc.status = "exited";
			proc.exitedAt = this.deps.now();
			proc.exitCode = code;
			if (proc.exitedAt - (proc.startedAt ?? proc.exitedAt) > AUTO_RESET_UPTIME_MS) proc.restarts = 0;
			this.emitState(workspaceId, proc);
			if (proc.respawnOnClose) {
				proc.respawnOnClose = false;
				queueMicrotask(() => {
					this.start(workspaceId, proc.group);
				});
				return;
			}
			if (proc.group.autoRestart === true && !proc.stoppedByUser && code !== null && code !== 0 && proc.restarts < AUTO_RESTART_MAX) {
				proc.restarts += 1;
				const delay = Math.min(AUTO_RESTART_BASE_MS * 2 ** (proc.restarts - 1), AUTO_RESTART_MAX_MS);
				proc.autoTimer = setTimeout(() => {
					proc.autoTimer = void 0;
					if (this.shuttingDown || proc.status !== "exited") return;
					this.start(workspaceId, proc.group, { preserveRestarts: true });
				}, delay);
				proc.autoTimer.unref?.();
			}
		});
		this.emitState(workspaceId, proc);
		return { ok: true };
	}
	/**
	* Stop one group: best-effort tree kill. Also cancels a pending
	* auto-restart (a stop during the backoff wait is a user intent and must
	* not be undone by the timer). Returns ok=false when not running.
	*/
	stop(workspaceId, group) {
		const proc = this.procs.get(this.key(workspaceId, group.id));
		if (proc === void 0) return {
			ok: false,
			detail: "未在运行"
		};
		this.clearAutoTimer(proc);
		this.stopReadinessPoll(proc);
		if (proc.status !== "running" || proc.child === void 0) {
			proc.stoppedByUser = true;
			return {
				ok: false,
				detail: "未在运行"
			};
		}
		proc.stoppedByUser = true;
		killTree(proc.child, proc.pid, isWindows());
		const grace = this.deps.killGraceMs();
		const child = proc.child;
		setTimeout(() => {
			if (proc.status === "running" && proc.child === child) try {
				child.kill("SIGKILL");
			} catch {}
		}, grace).unref?.();
		return { ok: true };
	}
	/**
	* Restart: when running, arm a respawn on the close event (the tree kill
	* is asynchronous — respawning before 'close' would race the kill, hit the
	* still-'running' status, and report "已在运行"); when not running, start
	* immediately.
	*/
	restart(workspaceId, group) {
		const proc = this.procs.get(this.key(workspaceId, group.id));
		if (proc !== void 0 && proc.status === "running") {
			proc.respawnOnClose = true;
			this.stop(workspaceId, group);
			return {
				ok: true,
				detail: "正在重启"
			};
		}
		return this.start(workspaceId, group);
	}
	/** Buffered history for catch-up: lines with seq > afterSeq. */
	historyAfter(workspaceId, groupId, afterSeq) {
		const proc = this.procs.get(this.key(workspaceId, groupId));
		if (proc === void 0) return [];
		const chunks = [];
		for (const line of proc.history) {
			if (line.seq <= afterSeq) continue;
			const last = chunks.at(-1);
			if (last !== void 0 && last.stream === line.stream && last.seq + last.lines.length === line.seq) last.lines.push(line.text);
			else chunks.push({
				g: groupId,
				seq: line.seq,
				lines: [line.text],
				stream: line.stream
			});
		}
		return chunks;
	}
	/** Highest seq emitted for the group (0 when never run). */
	seqOf(workspaceId, groupId) {
		const proc = this.procs.get(this.key(workspaceId, groupId));
		if (proc === void 0 || proc.history.length === 0) return 0;
		return proc.history.at(-1)?.seq ?? 0;
	}
	/** True when the group has any buffered history (advertised on /state). */
	hasHistoryFor(workspaceId, groupId) {
		return (this.procs.get(this.key(workspaceId, groupId))?.history.length ?? 0) > 0;
	}
	/** Clear a pending auto-restart timer (no-op when none). */
	clearAutoTimer(proc) {
		if (proc.autoTimer !== void 0) {
			clearTimeout(proc.autoTimer);
			proc.autoTimer = void 0;
		}
	}
	/** Begin the readiness probe loop for this run (no-op without readyUrl). */
	startReadinessPoll(workspaceId, proc) {
		this.stopReadinessPoll(proc);
		const url = proc.group.readyUrl;
		if (url === void 0 || url === "") return;
		/** One probe: ANY HTTP response means the server is listening. */
		const probe = async () => {
			if (proc.status !== "running" || proc.child === void 0 || proc.ready) return;
			const abort = new AbortController();
			proc.pollAbort = abort;
			const timeout = setTimeout(() => {
				abort.abort();
			}, READY_TIMEOUT_MS);
			timeout.unref?.();
			try {
				await fetch(url, {
					signal: abort.signal,
					redirect: "follow"
				});
				if (proc.status === "running" && !proc.ready) {
					proc.ready = true;
					this.stopReadinessPoll(proc);
					this.emit("state", {
						type: "state",
						workspaceId
					});
				}
			} catch {} finally {
				clearTimeout(timeout);
			}
		};
		proc.pollTimer = setInterval(() => {
			probe();
		}, READY_POLL_MS);
		proc.pollTimer.unref?.();
		probe();
	}
	/** Stop the readiness probe loop and abort an in-flight probe. */
	stopReadinessPoll(proc) {
		if (proc.pollTimer !== void 0) {
			clearInterval(proc.pollTimer);
			proc.pollTimer = void 0;
		}
		if (proc.pollAbort !== void 0) {
			proc.pollAbort.abort();
			proc.pollAbort = void 0;
		}
	}
	/** Extract localhost-ish ports mentioned in one output line. */
	scanPorts(proc, line) {
		if (proc.ports.length >= MAX_PORTS) return;
		for (const match of line.matchAll(PORT_RE)) {
			const port = Number(match[1]);
			if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
			if (!proc.ports.includes(port)) {
				proc.ports.push(port);
				if (proc.ports.length >= MAX_PORTS) return;
			}
		}
	}
	/** Ingest one stdout/stderr data chunk: decode, split lines, buffer, emit. */
	ingest(workspaceId, proc, buf, stream) {
		const lines = (proc.pending[stream] + buf.toString("utf8")).split("\n");
		proc.pending[stream] = lines.pop() ?? "";
		this.pushLines(workspaceId, proc, lines, stream);
	}
	/** Flush a pending partial line (on process close). */
	flushPending(workspaceId, proc, stream) {
		const rest = proc.pending[stream];
		if (rest === "") return;
		proc.pending[stream] = "";
		this.pushLines(workspaceId, proc, [rest], stream);
	}
	/** Buffer lines (respecting the ceiling) and emit one output event. */
	pushLines(workspaceId, proc, lines, stream) {
		if (lines.length === 0) return;
		const seqs = [];
		const texts = [];
		for (const rawLine of lines) {
			const line = rawLine.replace(/\r$/, "");
			this.scanPorts(proc, line);
			const seq = proc.nextSeq++;
			seqs.push(seq);
			texts.push(line);
			proc.history.push({
				seq,
				stream,
				text: line
			});
			proc.historyBytes += line.length + 1;
		}
		while (proc.history.length > this.maxHistoryLines) proc.history.shift();
		const firstSeq = seqs[0] ?? 0;
		this.emit("output", {
			type: "output",
			workspaceId,
			chunk: {
				g: proc.group.id,
				seq: firstSeq,
				lines: texts,
				stream
			}
		});
	}
	/** Emit a state event for the proc's workspace. */
	emitState(workspaceId, _proc) {
		this.emit("state", {
			type: "state",
			workspaceId
		});
	}
	/** Snapshot of every workspace's running keys (for dispose-all). */
	runningWorkspaces() {
		const ids = /* @__PURE__ */ new Set();
		for (const proc of this.procs.values()) if (proc.status === "running") ids.add(proc.workspaceId);
		return [...ids];
	}
	/**
	* Stop everything (host dispose). Default policy: kill the trees — a
	* closed host cannot supervise orphans, and users said the GUI closing
	* should not leave stray dev servers.
	*/
	dispose() {
		this.shuttingDown = true;
		for (const proc of this.procs.values()) {
			this.clearAutoTimer(proc);
			this.stopReadinessPoll(proc);
			if (proc.status === "running" && proc.child !== void 0) {
				proc.stoppedByUser = true;
				try {
					killTree(proc.child, proc.pid, isWindows());
				} catch {}
			}
		}
		this.removeAllListeners();
	}
};
/** Join root + relative cwd without node:path (Windows-safe already normalized). */
function joinPath(root, cwd) {
	if (cwd === "") return root;
	return `${root.replace(/[\\/]+$/, "")}\\${cwd.replace(/\//g, "\\")}`;
}
/** process.env copy as Record<string,string> (drops undefined values). */
function processEnv() {
	const env = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	return env;
}
/** Readable message from an unknown error. */
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
//#endregion
export { ProcessSupervisor, errorMessage, joinPath, processEnv, realSpawnDeps };

//# sourceMappingURL=supervisor.js.map