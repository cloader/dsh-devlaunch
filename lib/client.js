window.__ModuleLoader__.load({
	id: "dsh-devlaunch",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react_dom_client = require("react-dom/client");
		let react = require("react");
		let react_dom = require("react-dom");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region src/client/controller.ts
		/** Max lines kept per group client-side (UI window; host keeps 2000). */
		const CLIENT_MAX_LINES = 2e3;
		/** Idle ms before an unsubscribed workspace's stream closes. */
		const STREAM_IDLE_MS = 3e4;
		/** localStorage keys (per browser, best-effort). */
		const LS_PROFILE_KEY = "dsh-devlaunch:profile-selection";
		const LS_PROFILE_MAX = 64;
		/**
		* Cross-group port conflicts: a port held by 2+ RUNNING groups. Returns
		* groupId → conflicting port. Pure function over a runs record.
		*/
		function portConflicts(runs) {
			const byPort = /* @__PURE__ */ new Map();
			for (const [groupId, run] of Object.entries(runs)) {
				if (run.status !== "running") continue;
				for (const port of run.ports ?? []) {
					const holders = byPort.get(port) ?? [];
					holders.push(groupId);
					byPort.set(port, holders);
				}
			}
			const conflicts = /* @__PURE__ */ new Map();
			for (const [port, holders] of byPort) {
				if (holders.length < 2) continue;
				for (const groupId of holders) conflicts.set(groupId, port);
			}
			return conflicts;
		}
		/** POST helper with envelope unwrapping. */
		async function post(path, body) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const parsed = await res.json().catch(() => null);
			if (parsed === null) throw new Error(`devlaunch: HTTP ${res.status}`);
			if (!parsed.ok) throw new Error(`devlaunch: ${parsed.error?.message ?? res.status}`);
			return parsed.value;
		}
		/** GET helper. */
		async function get(path) {
			const res = await fetch(path);
			const parsed = await res.json().catch(() => null);
			if (parsed === null) throw new Error(`devlaunch: HTTP ${res.status}`);
			if (!parsed.ok) throw new Error(`devlaunch: ${parsed.error?.message ?? res.status}`);
			return parsed.value;
		}
		/** Read the persisted per-workspace preset selection (best-effort). */
		function readPersistedProfiles() {
			const out = /* @__PURE__ */ new Map();
			try {
				const raw = localStorage.getItem(LS_PROFILE_KEY);
				if (raw === null) return out;
				const parsed = JSON.parse(raw);
				for (const [id, value] of Object.entries(parsed)) if (typeof value === "string") out.set(id, value);
			} catch {}
			return out;
		}
		/**
		* The controller.
		*/
		var DevlaunchController = class {
			views = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			/** Reference counts: how many mounted components care per workspace. */
			refs = /* @__PURE__ */ new Map();
			streams = /* @__PURE__ */ new Map();
			idleTimers = /* @__PURE__ */ new Map();
			/** Selected launch preset per workspace ('' = 全部/all-enabled). */
			profileSel = /* @__PURE__ */ new Map();
			constructor() {
				this.profileSel = readPersistedProfiles();
			}
			/** Subscribe to all changes; returns unsubscribe. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/** Currently selected preset id for a workspace ('' = 全部). */
			selectedProfile(workspaceId) {
				return this.profileSel.get(workspaceId) ?? "";
			}
			/** Select a preset (persisted per browser, best-effort). */
			setSelectedProfile(workspaceId, profileId) {
				this.profileSel.set(workspaceId, profileId);
				try {
					const all = readPersistedProfiles();
					all.set(workspaceId, profileId);
					while (all.size > LS_PROFILE_MAX) {
						const first = all.keys().next().value;
						if (first === void 0) break;
						all.delete(first);
					}
					const record = {};
					for (const [id, value] of all) record[id] = value;
					localStorage.setItem(LS_PROFILE_KEY, JSON.stringify(record));
				} catch {}
				this.notify();
			}
			/**
			* Resolve the current start target for a workspace: the selected
			* preset's group ids, or undefined meaning "all enabled groups".
			*/
			profileTarget(workspaceId) {
				const view = this.views.get(workspaceId);
				const profile = (view?.config.profiles ?? []).find((p) => p.id === this.selectedProfile(workspaceId));
				if (profile === void 0) return {
					profileId: "",
					label: "全部",
					groupIds: void 0
				};
				const known = new Set((view?.config.groups ?? []).map((g) => g.id));
				return {
					profileId: profile.id,
					label: profile.label,
					groupIds: profile.groupIds.filter((id) => known.has(id))
				};
			}
			/**
			* Start the current target (preset groups, or all enabled) and stop any
			* RUNNING group outside the preset — one-click "switch the running set".
			* The all-enabled target keeps legacy behavior (starts enabled, stops nothing).
			*/
			async startTarget(workspaceId) {
				const { groupIds } = this.profileTarget(workspaceId);
				const outcomes = await this.start(workspaceId, groupIds);
				if (groupIds === void 0) return outcomes;
				await this.refreshState(workspaceId).catch(() => {});
				const view = this.views.get(workspaceId);
				if (view === void 0) return outcomes;
				const outside = Object.entries(view.runs).filter(([id, run]) => run.status === "running" && !groupIds.includes(id)).map(([id]) => id);
				if (outside.length > 0) await this.stop(workspaceId, outside).catch(() => {});
				return outcomes;
			}
			/** Notify listeners (batched into a microtask). */
			notify() {
				for (const listener of this.listeners) listener();
			}
			/** View for a workspace (undefined until first state arrives). */
			view(workspaceId) {
				return this.views.get(workspaceId);
			}
			/**
			* A component mounted for this workspace: ref-count the stream and pull
			* fresh state. Returns the release function.
			*/
			acquire(workspaceId) {
				const count = this.refs.get(workspaceId) ?? 0;
				this.refs.set(workspaceId, count + 1);
				const idle = this.idleTimers.get(workspaceId);
				if (idle !== void 0) {
					clearTimeout(idle);
					this.idleTimers.delete(workspaceId);
				}
				if (count === 0) this.openStream(workspaceId);
				return () => {
					this.release(workspaceId);
				};
			}
			/** Reference dropped; maybe close the stream after idling. */
			release(workspaceId) {
				const count = (this.refs.get(workspaceId) ?? 1) - 1;
				if (count > 0) {
					this.refs.set(workspaceId, count);
					return;
				}
				this.refs.set(workspaceId, 0);
				const timer = setTimeout(() => {
					if ((this.refs.get(workspaceId) ?? 0) > 0) return;
					this.closeStream(workspaceId);
					this.idleTimers.delete(workspaceId);
				}, STREAM_IDLE_MS);
				this.idleTimers.set(workspaceId, timer);
			}
			/** Open (or re-open) the SSE stream for a workspace. */
			openStream(workspaceId) {
				this.closeStream(workspaceId);
				const source = new EventSource(`/dsh-devlaunch/stream?workspace=${encodeURIComponent(workspaceId)}`);
				const view = this.ensureView(workspaceId);
				source.onopen = () => {
					view.connected = true;
					this.notify();
				};
				source.onerror = () => {
					view.connected = false;
					this.notify();
				};
				source.onmessage = (event) => {
					this.handleEvent(workspaceId, event.data);
				};
				this.streams.set(workspaceId, source);
				this.refreshState(workspaceId);
			}
			/** Close the SSE stream. */
			closeStream(workspaceId) {
				const source = this.streams.get(workspaceId);
				if (source !== void 0) {
					source.close();
					this.streams.delete(workspaceId);
				}
			}
			/** View slot creator. */
			ensureView(workspaceId) {
				let view = this.views.get(workspaceId);
				if (view === void 0) {
					view = {
						workspaceId,
						config: {
							groups: [],
							profiles: []
						},
						runs: {},
						lines: /* @__PURE__ */ new Map(),
						seq: {},
						connected: false
					};
					this.views.set(workspaceId, view);
				}
				return view;
			}
			/** One SSE data payload. */
			handleEvent(workspaceId, raw) {
				let event;
				try {
					event = JSON.parse(raw);
				} catch {
					return;
				}
				const view = this.ensureView(workspaceId);
				if (event.type === "state" && event.runs !== void 0) {
					view.runs = event.runs;
					this.notify();
					return;
				}
				if (event.type === "output" && event.chunk !== void 0) {
					this.appendChunk(view, event.chunk);
					this.notify();
					return;
				}
				if (event.type === "config") this.refreshState(workspaceId);
				if (event.type === "reset") this.refreshState(workspaceId);
			}
			/** Append one output chunk to the view. */
			appendChunk(view, chunk) {
				let lines = view.lines.get(chunk.g);
				if (lines === void 0) {
					lines = [];
					view.lines.set(chunk.g, lines);
				}
				const lastSeq = view.seq[chunk.g] ?? 0;
				if (chunk.seq > lastSeq + 1 && lastSeq > 0) this.mendHistory(view.workspaceId, chunk.g, lastSeq);
				chunk.lines.forEach((text, index) => {
					lines.push({
						seq: chunk.seq + index,
						stream: chunk.stream,
						text
					});
				});
				if (lines.length > CLIENT_MAX_LINES) lines.splice(0, lines.length - CLIENT_MAX_LINES);
				view.seq[chunk.g] = Math.max(lastSeq, chunk.seq + chunk.lines.length - 1);
			}
			/** Fetch missed lines for one group after a detected gap. */
			async mendHistory(workspaceId, groupId, afterSeq) {
				try {
					const value = await get(`/dsh-devlaunch/history?workspace=${encodeURIComponent(workspaceId)}&group=${encodeURIComponent(groupId)}&afterSeq=${afterSeq}`);
					const view = this.views.get(workspaceId);
					if (view === void 0) return;
					const lines = view.lines.get(groupId) ?? [];
					const known = new Set(lines.map((line) => line.seq));
					for (const chunk of value.chunks) chunk.lines.forEach((text, index) => {
						const seq = chunk.seq + index;
						if (!known.has(seq)) lines.push({
							seq,
							stream: chunk.stream,
							text
						});
					});
					lines.sort((a, b) => a.seq - b.seq);
					if (lines.length > CLIENT_MAX_LINES) lines.splice(0, lines.length - CLIENT_MAX_LINES);
					view.seq[groupId] = lines.length > 0 ? lines[lines.length - 1].seq : 0;
					this.notify();
				} catch {}
			}
			/** Full state pull (config + runs + whether history exists). */
			async refreshState(workspaceId) {
				try {
					const state = await get(`/dsh-devlaunch/state?workspace=${encodeURIComponent(workspaceId)}`);
					const view = this.ensureView(workspaceId);
					view.config = state.config;
					view.runs = state.runs;
					view.connected = true;
					this.notify();
				} catch (error) {
					const view = this.ensureView(workspaceId);
					view.connected = false;
					view.lastError = error instanceof Error ? error.message : String(error);
					this.notify();
				}
			}
			/** Save a workspace config (replaces all groups). */
			async saveConfig(workspaceId, config) {
				await post("/dsh-devlaunch/config", {
					workspace: workspaceId,
					config
				});
				await this.refreshState(workspaceId);
			}
			/** Start groups (default: all enabled). */
			async start(workspaceId, groupIds) {
				return post("/dsh-devlaunch/start", {
					workspace: workspaceId,
					groupIds
				});
			}
			/** Stop groups (default: all running). */
			async stop(workspaceId, groupIds) {
				return post("/dsh-devlaunch/stop", {
					workspace: workspaceId,
					groupIds
				});
			}
			/** Restart one group. */
			async restart(workspaceId, groupId) {
				return post("/dsh-devlaunch/restart", {
					workspace: workspaceId,
					group: groupId
				});
			}
			/** Fetch package.json script suggestions (root + subdirectories). */
			async packageScripts(workspaceId) {
				return (await get(`/dsh-devlaunch/package-scripts?workspace=${encodeURIComponent(workspaceId)}`)).scripts;
			}
			/** Clear the client-side output lines of one group (visual clear only). */
			clearLines(workspaceId, groupId) {
				const view = this.views.get(workspaceId);
				if (view === void 0) return;
				view.lines.set(groupId, []);
				this.notify();
			}
			/** Tear everything down (plugin dispose). */
			dispose() {
				for (const source of this.streams.values()) source.close();
				this.streams.clear();
				for (const timer of this.idleTimers.values()) clearTimeout(timer);
				this.idleTimers.clear();
				this.listeners.clear();
			}
		};

		//#endregion
		//#region src/client/styles.ts
		/**
		* Injected stylesheet: uses the DSH theme alias tokens (--dsw-alias-*)
		* so light/dark themes both render correctly without our own theme logic.
		* Accent hues are fixed mid-saturation colors (legible on both themes);
		* every tint is derived via color-mix so surfaces stay theme-native.
		*
		* Also fixes a latent bug from 0.1.x: --dsw-alias-fill-l2 does not exist
		* in the shipped theme CSS — those backgrounds silently vanished. All
		* former fill usages now use real tokens / color-mix.
		*
		* @module dsh-devlaunch/client/styles
		*/
		/** The stylesheet text. */
		const CSS = `
		/* ================= tokens (scoped to our mount roots) ================= */
		.dl-root, .dl-console-root, .dl-modal-scrim {
		  --dl-blue: #4176e6;
		  --dl-green: var(--dsw-alias-state-success-primary, #22c55e);
		  --dl-red: var(--dsw-alias-state-error-primary, #ef4444);
		  --dl-amber: var(--dsw-alias-state-warn-primary, #f59e0b);
		  --dl-violet: #8b5cf6;
		}
		.dl-root :focus-visible, .dl-console-root :focus-visible, .dl-modal-scrim :focus-visible {
		  outline: 2px solid color-mix(in srgb, var(--dl-blue) 60%, transparent);
		  outline-offset: 1px;
		}

		/* ================= keyframes ================= */
		@keyframes dl-pop-in {
		  from { opacity: 0; transform: translateY(-4px) scale(.985); }
		  to { opacity: 1; transform: none; }
		}
		@keyframes dl-fade-in { from { opacity: 0; } to { opacity: 1; } }
		@keyframes dl-modal-in {
		  from { opacity: 0; transform: translateY(10px) scale(.985); }
		  to { opacity: 1; transform: none; }
		}
		@keyframes dl-pulse {
		  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dl-green) 45%, transparent); }
		  70% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--dl-green) 0%, transparent); }
		  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dl-green) 0%, transparent); }
		}
		@media (prefers-reduced-motion: reduce) {
		  .dl-root *, .dl-console-root *, .dl-modal-scrim * {
		    animation-duration: .01ms !important;
		    animation-iteration-count: 1 !important;
		    transition-duration: .01ms !important;
		  }
		}

		/* ================= scrollbars ================= */
		.dl-menu::-webkit-scrollbar, .dl-modal-body::-webkit-scrollbar,
		.dl-console-scroll::-webkit-scrollbar, .dl-rail-list::-webkit-scrollbar {
		  width: 8px; height: 8px;
		}
		.dl-menu::-webkit-scrollbar-thumb, .dl-modal-body::-webkit-scrollbar-thumb,
		.dl-console-scroll::-webkit-scrollbar-thumb, .dl-rail-list::-webkit-scrollbar-thumb {
		  background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,.22));
		  border-radius: 8px; border: 2px solid transparent; background-clip: padding-box;
		}
		.dl-menu::-webkit-scrollbar-thumb:hover, .dl-modal-body::-webkit-scrollbar-thumb:hover,
		.dl-console-scroll::-webkit-scrollbar-thumb:hover, .dl-rail-list::-webkit-scrollbar-thumb:hover {
		  background: var(--dsw-alias-scrollbar-hover-l2, rgba(0,0,0,.32));
		  border: 2px solid transparent; background-clip: padding-box;
		}

		/* ================= header split pill ================= */
		.dl-root { position: relative; display: inline-flex; align-items: center; }
		.dl-pill {
		  display: inline-flex; align-items: stretch; height: 27px; border-radius: 999px;
		  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
		  overflow: hidden; transition: border-color .15s ease, box-shadow .15s ease;
		}
		.dl-pill[data-state="idle"]:hover:not(.dl-pill-disabled) {
		  border-color: color-mix(in srgb, var(--dl-blue) 45%, var(--dsw-alias-border-l2));
		  box-shadow: 0 1px 8px color-mix(in srgb, var(--dl-blue) 14%, transparent);
		}
		.dl-pill[data-state="running"] {
		  border-color: color-mix(in srgb, var(--dl-green) 45%, var(--dsw-alias-border-l2));
		}
		.dl-pill[data-state="running"]:hover:not(.dl-pill-disabled) {
		  border-color: color-mix(in srgb, var(--dl-red) 50%, var(--dsw-alias-border-l2));
		  box-shadow: 0 1px 8px color-mix(in srgb, var(--dl-red) 14%, transparent);
		}
		.dl-pill[data-state="empty"] { border-style: dashed; }
		.dl-pill[data-state="empty"]:hover:not(.dl-pill-disabled) {
		  border-color: color-mix(in srgb, var(--dl-amber) 60%, var(--dsw-alias-border-l2));
		  box-shadow: 0 1px 8px color-mix(in srgb, var(--dl-amber) 14%, transparent);
		}
		.dl-pill-disabled { opacity: .55; }
		.dl-trigger {
		  display: inline-flex; align-items: center; gap: 6px; padding: 0 10px 0 9px;
		  color: var(--dsw-alias-label-secondary); cursor: pointer; background: 0 0; border: 0;
		  font-size: 12px; line-height: 18px; font-weight: 500; transition: color .15s ease;
		}
		.dl-pill:hover:not(.dl-pill-disabled) .dl-trigger { color: var(--dsw-alias-label-primary); }
		.dl-trigger:disabled { cursor: default; }
		.dl-pill-ico { color: var(--dl-blue); display: inline-flex; flex: none; }
		.dl-pill[data-state="running"] .dl-pill-ico { color: var(--dl-red); }
		.dl-pill[data-state="empty"] .dl-pill-ico { color: var(--dl-amber); }
		.dl-pill-div { width: 1px; background: var(--dsw-alias-border-l2); margin: 5px 0; flex: none; }
		.dl-caret-btn {
		  display: inline-flex; align-items: center; padding: 0 8px; cursor: pointer;
		  background: 0 0; border: 0; color: var(--dsw-alias-label-tertiary); transition: color .15s ease;
		}
		.dl-pill:hover:not(.dl-pill-disabled) .dl-caret-btn { color: var(--dsw-alias-label-secondary); }
		.dl-caret-btn:disabled { cursor: default; }
		.dl-caret-btn svg { transition: transform .16s ease; }
		.dl-caret-flip { transform: rotate(180deg); }

		/* ================= status dots ================= */
		.dl-dot { width: 7px; height: 7px; border-radius: 999px; flex: none; display: inline-block; }
		.dl-dot-on {
		  background: var(--dl-green);
		  animation: dl-pulse 1.9s ease-out infinite;
		}
		.dl-dot-off { background: var(--dsw-alias-label-tertiary); opacity: .55; }
		.dl-dot-err {
		  background: var(--dl-red);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-red) 18%, transparent);
		}

		/* ================= dropdown menu ================= */
		.dl-menu {
		  z-index: 100; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2);
		  background: var(--dsw-specific-menu, var(--dsw-alias-bg-base));
		  width: 380px; max-width: min(420px, 100vw - 32px);
		  max-height: min(460px, 100vh - 140px);
		  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,.22));
		  border-radius: 12px; display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 4px;
		  position: absolute; top: calc(100% + 6px); right: 0; overflow: auto;
		  animation: dl-pop-in .16s cubic-bezier(.2,.9,.3,1);
		}
		.dl-menu-head { display: flex; align-items: center; justify-content: space-between; padding: 7px 8px 5px; }
		.dl-menu-title {
		  color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 600;
		  letter-spacing: .02em; display: inline-flex; align-items: center; gap: 6px;
		}
		.dl-menu-title svg { color: var(--dl-blue); }
		.dl-menu-config {
		  display: inline-flex; align-items: center; gap: 5px;
		  background: 0 0; border: 0; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px;
		  border-radius: 7px; padding: 3px 7px; transition: color .12s, background .12s;
		}
		.dl-menu-config:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
		.dl-menu-error {
		  margin: 2px 6px 4px; padding: 7px 10px; border-radius: 8px; font-size: 12px;
		  color: var(--dl-red); background: color-mix(in srgb, var(--dl-red) 10%, transparent);
		  border: 1px solid color-mix(in srgb, var(--dl-red) 22%, transparent);
		}
		.dl-menu-row {
		  display: flex; align-items: center; gap: 8px; min-height: 36px; border-radius: 8px;
		  padding: 5px 8px; font-size: 13px; color: var(--dsw-alias-label-primary);
		  transition: background .12s ease;
		}
		.dl-menu-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
		.dl-menu-row[data-running] { color: var(--dsw-alias-label-primary); }

		/* kind chips (shared everywhere) */
		.dl-kind {
		  flex: none; border-radius: 5px; padding: 0 6px; font-size: 11px; line-height: 18px; font-weight: 500;
		}
		.dl-kind[data-kind="frontend"] {
		  color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 13%, transparent);
		}
		.dl-kind[data-kind="backend"] {
		  color: var(--dl-green); background: color-mix(in srgb, var(--dl-green) 13%, transparent);
		}
		.dl-kind[data-kind="other"] {
		  color: var(--dl-violet); background: color-mix(in srgb, var(--dl-violet) 13%, transparent);
		}

		.dl-row-label {
		  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		  font-family: var(--ds-font-family-code, monospace); font-size: 12px;
		}
		.dl-row-status {
		  flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		  color: var(--dsw-alias-label-tertiary); font-size: 11px;
		}
		.dl-row-actions { display: inline-flex; gap: 2px; flex: none; }
		.dl-menu-empty {
		  padding: 18px 14px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 20px;
		  display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
		}
		.dl-menu-empty svg { opacity: .55; }
		.dl-menu-foot { display: flex; gap: 6px; padding: 6px; border-top: 1px solid var(--dsw-alias-border-l2); margin-top: 3px; }

		/* ================= shared small controls ================= */
		.dl-mini {
		  min-width: 24px; height: 24px; display: inline-grid; place-items: center; cursor: pointer;
		  background: 0 0; border: 1px solid transparent; border-radius: 7px;
		  color: var(--dsw-alias-label-tertiary); padding: 0 3px;
		  transition: color .12s, background .12s, border-color .12s;
		}
		.dl-mini:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
		.dl-mini:active:not(:disabled) { transform: translateY(.5px); }
		.dl-mini:disabled { opacity: .35; cursor: default; }
		.dl-mini-go:hover:not(:disabled) { color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 12%, transparent); }
		.dl-mini-stop:hover:not(:disabled) { color: var(--dl-red); background: color-mix(in srgb, var(--dl-red) 12%, transparent); }
		.dl-mini-restart:hover:not(:disabled) { color: var(--dl-amber); background: color-mix(in srgb, var(--dl-amber) 12%, transparent); }
		.dl-mini-copy:hover:not(:disabled) { color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 12%, transparent); }
		.dl-mini-copy-done { color: var(--dl-green); }

		.dl-foot-btn {
		  flex: 1; min-height: 30px; cursor: pointer; background: 0 0;
		  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
		  color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 10px;
		  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
		  transition: color .12s, background .12s, border-color .12s;
		}
		.dl-foot-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
		.dl-foot-btn:active:not(:disabled) { transform: translateY(.5px); }
		.dl-foot-btn:disabled { opacity: .4; cursor: default; }
		.dl-foot-btn.dl-foot-danger:hover:not(:disabled) {
		  color: var(--dl-red); border-color: color-mix(in srgb, var(--dl-red) 40%, transparent);
		  background: color-mix(in srgb, var(--dl-red) 8%, transparent);
		}
		.dl-foot-go {
		  color: #fff; background: var(--dl-blue); border-color: transparent;
		  box-shadow: 0 1px 6px color-mix(in srgb, var(--dl-blue) 30%, transparent);
		}
		.dl-foot-go:hover:not(:disabled) {
		  color: #fff; background: color-mix(in srgb, var(--dl-blue) 86%, #000);
		  box-shadow: 0 2px 10px color-mix(in srgb, var(--dl-blue) 38%, transparent);
		}

		/* ================= console view (session tab) ================= */
		.dl-console-root { display: flex; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); }
		.dl-console-rail {
		  width: 230px; flex: none; display: flex; flex-direction: column; padding: 10px 8px 8px;
		  border-right: 1px solid var(--dsw-alias-border-l2); overflow: hidden;
		}
		.dl-rail-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
		.dl-rail-head {
		  display: flex; justify-content: space-between; align-items: center; padding: 0 6px 8px;
		  color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600;
		}
		.dl-conn { color: var(--dsw-alias-label-tertiary); font-size: 10px; }
		.dl-conn-on { color: var(--dl-green); font-size: 10px; }
		.dl-rail-item {
		  display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; cursor: pointer;
		  background: 0 0; border: 0; border-radius: 8px; padding: 7px 8px;
		  color: var(--dsw-alias-label-secondary); font-size: 12px;
		  transition: background .12s, color .12s;
		}
		.dl-rail-item:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
		.dl-rail-item-on {
		  background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary);
		  box-shadow: inset 2px 0 0 var(--dl-blue);
		}
		.dl-rail-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.dl-rail-dur { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
		.dl-rail-dur-run { color: var(--dl-green); }
		.dl-rail-dur-err { color: var(--dl-red); }
		.dl-rail-empty {
		  padding: 18px 8px; color: var(--dsw-alias-label-tertiary); font-size: 12px;
		  display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; line-height: 18px;
		}
		.dl-rail-empty svg { opacity: .5; }
		.dl-rail-config {
		  cursor: pointer; background: 0 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
		  color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 5px 12px; width: fit-content;
		  display: inline-flex; align-items: center; gap: 6px; transition: all .12s;
		}
		.dl-rail-config:hover {
		  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-blue) 8%, transparent);
		}
		.dl-rail-foot {
		  flex: none; display: flex; gap: 6px; padding-top: 8px; margin-top: 8px;
		  border-top: 1px solid var(--dsw-alias-border-l2);
		}
		.dl-rail-foot-btn {
		  flex: 1; min-height: 27px; cursor: pointer; background: 0 0;
		  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px;
		  color: var(--dsw-alias-label-tertiary); font-size: 11px; padding: 3px 6px;
		  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
		  transition: all .12s;
		}
		.dl-rail-foot-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
		.dl-rail-foot-btn:disabled { opacity: .35; cursor: default; }
		.dl-rail-foot-go:hover:not(:disabled) { color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent); background: color-mix(in srgb, var(--dl-blue) 8%, transparent); }
		.dl-rail-foot-stop:hover:not(:disabled) { color: var(--dl-red); border-color: color-mix(in srgb, var(--dl-red) 45%, transparent); background: color-mix(in srgb, var(--dl-red) 8%, transparent); }

		/* ---- console main ---- */
		.dl-console-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
		.dl-console-bar {
		  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
		  border-bottom: 1px solid var(--dsw-alias-border-l2); flex: none; flex-wrap: wrap;
		}
		.dl-console-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; white-space: nowrap; }
		.dl-console-cmd {
		  font-family: var(--ds-font-family-code, monospace); font-size: 11px;
		  color: var(--dsw-alias-label-secondary);
		  background: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-interactive-bg-hover));
		  border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 2px 7px;
		  max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		}
		.dl-console-cwd {
		  font-family: var(--ds-font-family-code, monospace); font-size: 11px;
		  color: var(--dsw-alias-label-tertiary);
		}
		.dl-chip {
		  display: inline-flex; align-items: center; gap: 5px; border-radius: 999px; padding: 2px 9px;
		  font-size: 11px; line-height: 16px; border: 1px solid var(--dsw-alias-border-l2);
		  color: var(--dsw-alias-label-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums;
		}
		.dl-chip[data-state="running"] {
		  color: var(--dl-green); border-color: color-mix(in srgb, var(--dl-green) 35%, transparent);
		  background: color-mix(in srgb, var(--dl-green) 9%, transparent);
		}
		.dl-chip[data-state="error"] {
		  color: var(--dl-red); border-color: color-mix(in srgb, var(--dl-red) 35%, transparent);
		  background: color-mix(in srgb, var(--dl-red) 9%, transparent);
		}
		.dl-console-actions { display: inline-flex; gap: 3px; margin-left: auto; flex: none; }

		.dl-console-scroll {
		  flex: 1; min-height: 0; overflow-y: auto; padding: 10px 0 16px;
		  font-family: var(--ds-font-family-code, monospace); font-size: 12px; line-height: 19px;
		  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-base));
		}
		.dl-line { display: flex; gap: 10px; padding: 0 12px; white-space: pre-wrap; word-break: break-word; }
		.dl-line:hover { background: var(--dsw-alias-interactive-bg-hover); }
		.dl-line-seq {
		  flex: none; width: 44px; text-align: right; color: var(--dsw-alias-label-tertiary);
		  opacity: .55; user-select: none; font-size: 10px; line-height: 19px;
		}
		.dl-line-text { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); }
		.dl-line-err .dl-line-text { color: var(--dl-red); }
		.dl-mark {
		  background: color-mix(in srgb, var(--dl-amber) 38%, transparent);
		  color: inherit; border-radius: 2px; padding: 0 1px;
		}
		.dl-console-nooutput, .dl-console-empty {
		  padding: 48px 24px; color: var(--dsw-alias-label-tertiary); font-size: 13px;
		  display: flex; flex-direction: column; align-items: center; justify-content: center;
		  gap: 10px; height: 100%; box-sizing: border-box; text-align: center;
		}
		.dl-console-nooutput svg, .dl-console-empty svg { opacity: .45; }
		.dl-follow-btn {
		  position: sticky; bottom: 12px; margin: 0 auto; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2);
		  background: color-mix(in srgb, var(--dsw-alias-bg-base) 84%, transparent);
		  backdrop-filter: blur(6px);
		  color: var(--dsw-alias-label-secondary); border-radius: 999px; font-size: 11px; padding: 5px 14px;
		  box-shadow: var(--dsw-shadow-lv2, 0 2px 10px rgba(0,0,0,.15));
		  display: inline-flex; align-items: center; gap: 6px;
		  animation: dl-fade-in .15s ease; transition: color .12s, border-color .12s;
		}
		.dl-follow-btn:hover {
		  color: var(--dsw-alias-label-primary);
		  border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		}

		/* ---- console search / filter ---- */
		.dl-search-wrap { position: relative; display: inline-flex; align-items: center; flex: none; }
		.dl-search-wrap > svg {
		  position: absolute; left: 8px; color: var(--dsw-alias-label-tertiary); pointer-events: none;
		}
		.dl-search {
		  height: 26px; width: 160px; border-radius: 8px; box-sizing: border-box;
		  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base);
		  color: var(--dsw-alias-label-primary); font-size: 12px; padding: 0 8px 0 27px;
		  transition: border-color .15s, box-shadow .15s, width .2s ease;
		}
		.dl-search:focus {
		  outline: none; width: 200px;
		  border-color: color-mix(in srgb, var(--dl-blue) 55%, transparent);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-blue) 14%, transparent);
		}
		.dl-search::placeholder { color: var(--dsw-alias-label-tertiary); }
		.dl-toggle-btn {
		  height: 26px; display: inline-flex; align-items: center; gap: 5px; padding: 0 9px;
		  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: 0 0;
		  color: var(--dsw-alias-label-tertiary); font-size: 11px; cursor: pointer;
		  transition: color .12s, background .12s, border-color .12s; flex: none;
		}
		.dl-toggle-btn:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
		.dl-toggle-btn[aria-pressed="true"] {
		  color: var(--dl-red);
		  border-color: color-mix(in srgb, var(--dl-red) 40%, transparent);
		  background: color-mix(in srgb, var(--dl-red) 10%, transparent);
		}
		.dl-filter-count {
		  font-size: 10px; color: var(--dsw-alias-label-tertiary); white-space: nowrap;
		  font-variant-numeric: tabular-nums;
		}

		/* ================= config modal ================= */
		.dl-modal-scrim {
		  position: fixed; inset: 0; z-index: 200;
		  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.4));
		  backdrop-filter: blur(3px);
		  display: flex; align-items: flex-start; justify-content: center; padding: 8vh 16px 16px;
		  animation: dl-fade-in .18s ease;
		}
		.dl-modal {
		  width: 660px; max-width: 100%; max-height: 84vh; display: flex; flex-direction: column;
		  background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px;
		  box-shadow: var(--dsw-shadow-lv3, 0 16px 44px rgba(0,0,0,.3));
		  animation: dl-modal-in .2s cubic-bezier(.2,.9,.3,1);
		}
		.dl-modal-head {
		  display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px;
		  border-bottom: 1px solid var(--dsw-alias-border-l2);
		}
		.dl-modal-badge {
		  width: 28px; height: 28px; border-radius: 9px; display: grid; place-items: center; flex: none;
		  color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 12%, transparent);
		}
		.dl-modal-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
		.dl-modal-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); display: inline-flex; gap: 3px; align-items: center; }
		.dl-modal-close {
		  margin-left: auto; width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer;
		  background: 0 0; border: 0; border-radius: 8px; color: var(--dsw-alias-label-tertiary);
		  transition: color .12s, background .12s;
		}
		.dl-modal-close:hover { background: color-mix(in srgb, var(--dl-red) 12%, transparent); color: var(--dl-red); }
		.dl-modal-body {
		  flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px;
		  display: flex; flex-direction: column; gap: 10px;
		}
		.dl-form-row {
		  border: 1px solid var(--dsw-alias-border-l2); border-left-width: 3px;
		  border-radius: 10px; padding: 10px 10px 10px 12px;
		  display: flex; flex-direction: column; gap: 6px;
		  transition: border-color .15s, box-shadow .15s;
		}
		.dl-form-row:hover {
		  border-color: color-mix(in srgb, var(--dsw-alias-label-tertiary) 35%, var(--dsw-alias-border-l2));
		  border-left-color: var(--dl-row-accent, var(--dl-blue));
		}
		.dl-form-row[data-kind="frontend"] { border-left-color: var(--dl-blue); --dl-row-accent: var(--dl-blue); }
		.dl-form-row[data-kind="backend"] { border-left-color: var(--dl-green); --dl-row-accent: var(--dl-green); }
		.dl-form-row[data-kind="other"] { border-left-color: var(--dl-violet); --dl-row-accent: var(--dl-violet); }
		.dl-form-line1 { display: flex; align-items: center; gap: 8px; }
		.dl-form-kind {
		  flex: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
		  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
		  font-size: 12px; padding: 3px 4px; height: 26px; cursor: pointer;
		  transition: border-color .15s, box-shadow .15s;
		}
		.dl-form-label {
		  flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
		  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
		  font-size: 12px; padding: 4px 9px; height: 26px; box-sizing: border-box;
		  transition: border-color .15s, box-shadow .15s;
		}
		.dl-form-command, .dl-form-cwd, .dl-form-env {
		  width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
		  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
		  font-family: var(--ds-font-family-code, monospace); font-size: 12px; padding: 5px 9px;
		  transition: border-color .15s, box-shadow .15s;
		}
		.dl-form-kind:focus, .dl-form-label:focus, .dl-form-command:focus, .dl-form-cwd:focus, .dl-form-env:focus {
		  outline: none;
		  border-color: color-mix(in srgb, var(--dl-blue) 55%, transparent);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-blue) 14%, transparent);
		}
		.dl-form-label::placeholder, .dl-form-command::placeholder,
		.dl-form-cwd::placeholder, .dl-form-env::placeholder {
		  color: var(--dsw-alias-label-tertiary);
		}

		/* toggle switch */
		.dl-switch {
		  display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
		  color: var(--dsw-alias-label-secondary); font-size: 12px; user-select: none; flex: none;
		}
		.dl-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
		.dl-switch-track {
		  width: 30px; height: 17px; border-radius: 999px; flex: none; position: relative;
		  background: var(--dsw-alias-interactive-bg-hover);
		  border: 1px solid var(--dsw-alias-border-l2);
		  transition: background .16s, border-color .16s;
		}
		.dl-switch-track::after {
		  content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px;
		  border-radius: 999px; background: var(--dsw-alias-label-tertiary);
		  transition: transform .16s ease, background .16s;
		}
		.dl-switch input:checked + .dl-switch-track {
		  background: color-mix(in srgb, var(--dl-green) 60%, transparent);
		  border-color: color-mix(in srgb, var(--dl-green) 60%, transparent);
		}
		.dl-switch input:checked + .dl-switch-track::after { transform: translateX(13px); background: #fff; }
		.dl-switch input:focus-visible + .dl-switch-track {
		  outline: 2px solid color-mix(in srgb, var(--dl-blue) 60%, transparent); outline-offset: 1px;
		}

		.dl-form-order { display: inline-flex; gap: 2px; }
		.dl-form-line3 { display: flex; gap: 8px; }
		.dl-form-cwd { flex: 1; }
		.dl-form-env {
		  flex: 1; resize: vertical; min-height: 40px; font-size: 11px;
		}

		/* add buttons */
		.dl-form-adds { display: flex; gap: 6px; flex-wrap: wrap; }
		.dl-add-btn {
		  min-height: 30px; cursor: pointer; background: 0 0;
		  border: 1px dashed var(--dsw-alias-border-l2); border-radius: 8px;
		  color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 4px 12px;
		  display: inline-flex; align-items: center; gap: 6px;
		  transition: color .13s, border-color .13s, background .13s, border-style .13s;
		}
		.dl-add-btn:hover { border-style: solid; color: var(--dsw-alias-label-primary); }
		.dl-add-btn[data-kind="frontend"]:hover {
		  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-blue) 8%, transparent);
		}
		.dl-add-btn[data-kind="backend"]:hover {
		  color: var(--dl-green); border-color: color-mix(in srgb, var(--dl-green) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-green) 8%, transparent);
		}
		.dl-add-btn[data-kind="other"]:hover {
		  color: var(--dl-violet); border-color: color-mix(in srgb, var(--dl-violet) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-violet) 8%, transparent);
		}
		.dl-add-btn[data-import]:hover {
		  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-blue) 8%, transparent);
		}

		/* import suggestions */
		.dl-suggest {
		  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden;
		}
		.dl-suggest-head {
		  display: flex; justify-content: space-between; align-items: center; padding: 7px 10px;
		  background: var(--dsw-alias-interactive-bg-hover);
		  color: var(--dsw-alias-label-secondary); font-size: 12px;
		}
		.dl-suggest-empty { padding: 12px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
		.dl-suggest-row {
		  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; cursor: pointer;
		  background: 0 0; border: 0; border-top: 1px solid var(--dsw-alias-border-l1);
		  padding: 6px 10px; transition: background .12s;
		}
		.dl-suggest-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
		.dl-suggest-cwd {
		  flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		  color: var(--dsw-alias-label-secondary);
		  background: var(--dsw-alias-markdown-inline-code, var(--dsw-alias-interactive-bg-hover));
		  border-radius: 5px; font-size: 10px; padding: 1px 6px;
		}
		.dl-suggest-name {
		  flex: none; width: 110px; overflow: hidden; text-overflow: ellipsis;
		  color: var(--dsw-alias-label-primary); font-size: 12px;
		}
		.dl-suggest-cmd {
		  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
		  color: var(--dsw-alias-label-tertiary); font-size: 11px;
		}
		.dl-suggest-add {
		  flex: none; color: var(--dl-blue); font-size: 11px;
		  display: inline-flex; align-items: center; gap: 3px;
		}

		/* modal footer */
		.dl-modal-foot {
		  display: flex; align-items: center; gap: 8px; padding: 12px 16px 14px;
		  border-top: 1px solid var(--dsw-alias-border-l2);
		}
		.dl-modal-note { margin-right: auto; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
		.dl-modal-foot .dl-foot-btn { flex: none; min-width: 84px; }

		/* ================= ready / restarts / ports ================= */
		.dl-dot-ready {
		  background: var(--dl-green);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-green) 22%, transparent);
		}
		.dl-status-ready { color: var(--dl-blue); }
		.dl-restart-badge {
		  flex: none; display: inline-flex; align-items: center; gap: 3px;
		  color: var(--dl-amber); font-size: 10px; font-variant-numeric: tabular-nums;
		}
		.dl-ports { display: inline-flex; gap: 4px; flex: none; }
		.dl-port-chip {
		  display: inline-flex; align-items: center; gap: 3px; border-radius: 6px; padding: 1px 7px;
		  font-size: 10px; line-height: 16px; text-decoration: none; cursor: pointer;
		  font-family: var(--ds-font-family-code, monospace); font-variant-numeric: tabular-nums;
		  color: var(--dl-blue); background: color-mix(in srgb, var(--dl-blue) 10%, transparent);
		  border: 1px solid color-mix(in srgb, var(--dl-blue) 25%, transparent);
		  transition: background .12s, border-color .12s;
		}
		.dl-port-chip:hover {
		  background: color-mix(in srgb, var(--dl-blue) 18%, transparent);
		  border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		}
		.dl-port-chip[data-conflict="true"] {
		  color: var(--dl-red); background: color-mix(in srgb, var(--dl-red) 10%, transparent);
		  border-color: color-mix(in srgb, var(--dl-red) 40%, transparent);
		}
		.dl-rail-item[data-conflict="true"] { box-shadow: inset 2px 0 0 var(--dl-red); }
		.dl-menu-row[data-conflict="true"] { box-shadow: inset 2px 0 0 var(--dl-red); }

		/* ================= profile selector ================= */
		.dl-profile-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; padding: 0 6px 6px; }
		.dl-profile-label {
		  flex: none; color: var(--dsw-alias-label-tertiary); font-size: 10px;
		  display: inline-flex; align-items: center; gap: 3px; margin-right: 2px;
		}
		.dl-profile-chip {
		  border-radius: 999px; padding: 2px 10px; font-size: 11px; line-height: 16px; cursor: pointer;
		  border: 1px solid var(--dsw-alias-border-l2); background: 0 0;
		  color: var(--dsw-alias-label-tertiary); transition: color .12s, border-color .12s, background .12s;
		}
		.dl-profile-chip:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
		.dl-profile-chip[data-on="true"] {
		  color: var(--dl-blue); border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-blue) 9%, transparent); font-weight: 500;
		}

		/* ================= modal: group options + profiles editor ================= */
		.dl-form-line4 { display: flex; gap: 8px; align-items: flex-end; }
		.dl-form-line4 .dl-form-env { flex: 1; }
		.dl-form-opt {
		  flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 0 2px 4px;
		  color: var(--dsw-alias-label-secondary); font-size: 12px; cursor: pointer; user-select: none;
		  white-space: nowrap;
		}
		.dl-profiles-card {
		  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px;
		  display: flex; flex-direction: column; gap: 8px;
		}
		.dl-profiles-head {
		  display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary);
		  font-size: 12px; font-weight: 600;
		}
		.dl-profiles-head svg { color: var(--dl-blue); }
		.dl-profiles-head button { margin-left: auto; }
		.dl-profile-row { display: flex; flex-direction: column; gap: 6px; padding: 6px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-hover); }
		.dl-profile-line1 { display: flex; align-items: center; gap: 6px; }
		.dl-profile-name {
		  flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px;
		  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
		  font-size: 12px; padding: 4px 9px; height: 26px; box-sizing: border-box;
		  transition: border-color .15s, box-shadow .15s;
		}
		.dl-profile-name:focus {
		  outline: none; border-color: color-mix(in srgb, var(--dl-blue) 55%, transparent);
		  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dl-blue) 14%, transparent);
		}
		.dl-profile-members { display: flex; gap: 4px; flex-wrap: wrap; }
		.dl-member-chip {
		  border-radius: 6px; padding: 1px 8px; font-size: 11px; line-height: 17px; cursor: pointer;
		  border: 1px dashed var(--dsw-alias-border-l2); background: 0 0;
		  color: var(--dsw-alias-label-tertiary); transition: color .12s, border-color .12s, background .12s;
		}
		.dl-member-chip:hover { color: var(--dsw-alias-label-secondary); }
		.dl-member-chip[data-on="true"] {
		  color: var(--dl-blue); border-style: solid;
		  border-color: color-mix(in srgb, var(--dl-blue) 45%, transparent);
		  background: color-mix(in srgb, var(--dl-blue) 9%, transparent);
		}
		.dl-profiles-empty { color: var(--dsw-alias-label-tertiary); font-size: 12px; padding: 2px 2px 0; }
		`;
		/** Style tag marker. */
		const STYLE_ID = "dsh-devlaunch-styles";
		/** Inject once. */
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		//#endregion
		//#region src/shared/protocol.ts
		/** All valid kinds, in display order. */
		const GROUP_KINDS = [
			"frontend",
			"backend",
			"other"
		];
		/** New opaque group id. */
		function newGroupId() {
			return `g-${Math.random().toString(36).slice(2, 10)}`;
		}

		//#endregion
		//#region src/client/icons.tsx
		/** One svg wrapper. */
		function svg(props, children) {
			const size = props.size ?? 14;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				fill: "none",
				className: props.className,
				"aria-hidden": "true",
				focusable: "false",
				children
			});
		}
		/** Solid play triangle. */
		function IconPlay(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M5 3.2v9.6c0 .55.6.9 1.07.6l7.4-4.8a.7.7 0 0 0 0-1.2L6.07 2.6A.7.7 0 0 0 5 3.2Z",
				fill: "currentColor"
			}));
		}
		/** Solid stop square. */
		function IconStop(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "4.2",
				y: "4.2",
				width: "7.6",
				height: "7.6",
				rx: "1.6",
				fill: "currentColor"
			}));
		}
		/** Circular restart arrow. */
		function IconRestart(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.4 8a5.4 5.4 0 1 1-1.6-3.82" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M13.6 1.9v2.6h-2.6" })]
			}));
		}
		/** Trash bin. */
		function IconTrash(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.8 4.4h10.4" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.4 2.4h3.2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.6 4.4l.5 8.2c.03.55.47.98 1.02.98h3.76c.55 0 .99-.43 1.02-.98l.5-8.2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.6 7v3.8M9.4 7v3.8" })
				]
			}));
		}
		/** Settings gear (sun-gear form, legible at 12-14px). */
		function IconGear(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "8",
					cy: "8",
					r: "2.2"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" })]
			}));
		}
		/** Down chevron. */
		function IconChevron(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M4 6.2 8 10l4-3.8",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/** Plus. */
		function IconPlus(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M8 3.4v9.2M3.4 8h9.2",
				stroke: "currentColor",
				strokeWidth: "1.6",
				strokeLinecap: "round"
			}));
		}
		/** Arrow up. */
		function IconArrowUp(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M8 12.6V3.4M4.4 7 8 3.4 11.6 7",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/** Arrow down. */
		function IconArrowDown(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M8 3.4v9.2M4.4 9 8 12.6 11.6 9",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/** Close X. */
		function IconClose(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6",
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round"
			}));
		}
		/** Copy (two sheets). */
		function IconCopy(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "5.6",
					y: "5.6",
					width: "7",
					height: "7",
					rx: "1.5"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10.4 5.6V4A1.6 1.6 0 0 0 8.8 2.4H4A1.6 1.6 0 0 0 2.4 4v4.8A1.6 1.6 0 0 0 4 10.4h1.6" })]
			}));
		}
		/** Check. */
		function IconCheck(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M3.4 8.6 6.4 11.6 12.6 4.4",
				stroke: "currentColor",
				strokeWidth: "1.7",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		/** Search magnifier. */
		function IconSearch(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					cx: "7",
					cy: "7",
					r: "4.3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10.3 10.3 13.6 13.6" })]
			}));
		}
		/** Funnel filter. */
		function IconFunnel(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M2.4 3.4h11.2L9.4 8.5v3.7L6.6 13.6V8.5L2.4 3.4Z",
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinejoin: "round"
			}));
		}
		/** Download / import. */
		function IconImport(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.5",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 2.6v7.2M4.9 7 8 10.1 11.1 7" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.8 12.2v.6a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-.6" })]
			}));
		}
		/** Terminal box. */
		function IconTerminal(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "2",
					y: "3",
					width: "12",
					height: "10",
					rx: "1.8"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4.8 6.1 7 8l-2.2 1.9M8.8 10.3h2.8" })]
			}));
		}
		/** Stacked layers (launch presets). */
		function IconLayers(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.4",
				strokeLinejoin: "round",
				strokeLinecap: "round",
				fill: "none",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 2.1 14 5.3 8 8.5 2 5.3Z" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.6 8.7 8 11.6l5.4-2.9" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2.6 11.8 8 14.7l5.4-2.9" })
				]
			}));
		}
		/** File export (page with down arrow). */
		function IconExport(props) {
			return svg(props, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", {
				stroke: "currentColor",
				strokeWidth: "1.3",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 2.8h5.2L12.4 6v7.2a.9.9 0 0 1-.9.9H4a.9.9 0 0 1-.9-.9V3.7a.9.9 0 0 1 .9-.9Z" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9 2.9V6h3.3" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6.6 9.2v3.4M5 11.2l1.6 1.6 1.6-1.6" })
				]
			}));
		}

		//#endregion
		//#region src/client/config-modal.tsx
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
		/** Wire group → draft. */
		function toDraft(group) {
			return {
				id: group.id,
				kind: group.kind,
				label: group.label,
				command: group.command,
				cwd: group.cwd,
				envText: Object.entries(group.env).map(([k, v]) => `${k}=${v}`).join("\n"),
				enabled: group.enabled,
				readyUrlText: group.readyUrl ?? "",
				autoRestart: group.autoRestart === true
			};
		}
		/** Fresh empty draft. */
		function emptyDraft(kind) {
			return {
				id: newGroupId(),
				kind,
				label: "",
				command: "",
				cwd: "",
				envText: "",
				enabled: true,
				readyUrlText: "",
				autoRestart: false
			};
		}
		/** Wire profile → draft. */
		function profileToDraft(profile) {
			return {
				id: profile.id,
				label: profile.label,
				members: [...profile.groupIds]
			};
		}
		/** Parse env text → record; throws on malformed lines. */
		function parseEnv(text) {
			const env = {};
			for (const line of text.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed === "" || trimmed.startsWith("#")) continue;
				const eq = trimmed.indexOf("=");
				if (eq <= 0) throw new Error(`环境变量格式应为 KEY=VALUE：${trimmed}`);
				env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
			}
			return env;
		}
		/** Kind label. */
		function kindLabel$2(kind) {
			if (kind === "frontend") return "前端";
			if (kind === "backend") return "后端";
			return "其他";
		}
		/** The modal component (mounted once at the document level). */
		function ConfigModal(props) {
			const { controller } = props;
			const [workspaceId, setWorkspaceId] = (0, react.useState)(void 0);
			const [drafts, setDrafts] = (0, react.useState)([]);
			const [profileDrafts, setProfileDrafts] = (0, react.useState)([]);
			const [loaded, setLoaded] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [suggests, setSuggests] = (0, react.useState)([]);
			const [showSuggests, setShowSuggests] = (0, react.useState)(false);
			const inputRef = (0, react.useRef)(null);
			/** Open on the window event. */
			(0, react.useEffect)(() => {
				const onOpen = (event) => {
					const detail = event.detail;
					if (detail?.workspaceId === void 0) return;
					setWorkspaceId(detail.workspaceId);
					const view = controller.view(detail.workspaceId);
					setDrafts((view?.config.groups ?? []).map(toDraft));
					setProfileDrafts((view?.config.profiles ?? []).map(profileToDraft));
					setLoaded(false);
					setError(void 0);
					setShowSuggests(false);
				};
				window.addEventListener("dsh-devlaunch:config", onOpen);
				return () => {
					window.removeEventListener("dsh-devlaunch:config", onOpen);
				};
			}, [controller]);
			/** Refresh config when opened (in case another tab edited it). */
			(0, react.useEffect)(() => {
				if (workspaceId === void 0 || loaded) return;
				controller.refreshState(workspaceId).then(() => {
					const view = controller.view(workspaceId);
					setDrafts((view?.config.groups ?? []).map(toDraft));
					setProfileDrafts((view?.config.profiles ?? []).map(profileToDraft));
					setLoaded(true);
				});
			}, [
				controller,
				workspaceId,
				loaded
			]);
			/** Close on Escape. */
			const close = (0, react.useCallback)(() => {
				setWorkspaceId(void 0);
			}, []);
			/** Focus the first input on open. */
			(0, react.useEffect)(() => {
				if (workspaceId !== void 0) inputRef.current?.focus();
			}, [workspaceId]);
			const update = (index, patch) => {
				setDrafts((current) => current.map((d, i) => i === index ? {
					...d,
					...patch
				} : d));
			};
			const move = (index, delta) => {
				setDrafts((current) => {
					const next = [...current];
					const target = index + delta;
					if (target < 0 || target >= next.length) return current;
					const [item] = next.splice(index, 1);
					next.splice(target, 0, item);
					return next;
				});
			};
			const save = async () => {
				if (workspaceId === void 0) return;
				setSaving(true);
				setError(void 0);
				try {
					const groups = drafts.map((draft) => ({
						id: draft.id,
						kind: draft.kind,
						label: draft.label,
						command: draft.command,
						cwd: draft.cwd,
						env: parseEnv(draft.envText),
						enabled: draft.enabled,
						readyUrl: draft.readyUrlText.trim() === "" ? void 0 : draft.readyUrlText.trim(),
						autoRestart: draft.autoRestart
					}));
					const profiles = profileDrafts.filter((p) => p.members.length > 0).map((p) => ({
						id: p.id,
						label: p.label,
						groupIds: p.members
					}));
					await controller.saveConfig(workspaceId, {
						groups,
						profiles
					});
					close();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setSaving(false);
				}
			};
			const loadSuggests = async () => {
				if (workspaceId === void 0) return;
				setError(void 0);
				try {
					const scripts = await controller.packageScripts(workspaceId);
					setSuggests(scripts);
					setShowSuggests(true);
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				}
			};
			/** Append one suggestion as a new draft (carrying the package's cwd). */
			const applySuggest = (suggestion) => {
				const label = suggestion.cwd === "" ? suggestion.name : `${suggestion.cwd.split("/").at(-1) ?? suggestion.cwd}: ${suggestion.name}`;
				setDrafts((current) => [...current, {
					...emptyDraft("other"),
					label,
					command: suggestion.command,
					cwd: suggestion.cwd
				}]);
				setShowSuggests(false);
			};
			/** Patch one profile draft. */
			const updateProfile = (index, patch) => {
				setProfileDrafts((current) => current.map((p, i) => i === index ? {
					...p,
					...patch
				} : p));
			};
			/** Toggle one group's membership in one profile. */
			const toggleMember = (index, groupId) => {
				setProfileDrafts((current) => current.map((p, i) => {
					if (i !== index) return p;
					const members = p.members.includes(groupId) ? p.members.filter((id) => id !== groupId) : [...p.members, groupId];
					return {
						...p,
						members
					};
				}));
			};
			const kindCounts = (0, react.useMemo)(() => {
				const counts = {
					frontend: 0,
					backend: 0,
					other: 0
				};
				for (const draft of drafts) counts[draft.kind] += 1;
				return counts;
			}, [drafts]);
			if (workspaceId === void 0) return null;
			return (0, react_dom.createPortal)(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dl-modal-scrim",
				onKeyDown: (e) => {
					if (e.key === "Escape") close();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dl-modal",
					role: "dialog",
					"aria-label": "启动配置",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-modal-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dl-modal-badge",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminal, { size: 15 })
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dl-modal-title",
									children: "启动配置"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dl-modal-sub",
									children: [
										"前端 ",
										kindCounts.frontend,
										" · 后端 ",
										kindCounts.backend,
										" · 其他 ",
										kindCounts.other
									]
								})] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dl-modal-close",
									"aria-label": "关闭",
									onClick: close,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconClose, { size: 13 })
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-modal-body",
							children: [
								error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: "dl-menu-error",
									role: "alert",
									children: error
								}) : null,
								drafts.map((draft, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dl-form-row",
									"data-kind": draft.kind,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dl-form-line1",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
													className: "dl-form-kind",
													value: draft.kind,
													onChange: (e) => {
														update(index, { kind: e.target.value });
													},
													"aria-label": "类别",
													children: GROUP_KINDS.map((kind) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: kind,
														children: kindLabel$2(kind)
													}, kind))
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													ref: index === 0 ? inputRef : void 0,
													className: "dl-form-label",
													value: draft.label,
													placeholder: "名称（如 前端 Vite）",
													onChange: (e) => {
														update(index, { label: e.target.value });
													}
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: "dl-switch",
													title: "参与一键启动",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
															type: "checkbox",
															checked: draft.enabled,
															onChange: (e) => {
																update(index, { enabled: e.target.checked });
															}
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dl-switch-track" }),
														"启用"
													]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													className: "dl-form-order",
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: "dl-mini",
															title: "上移",
															onClick: () => {
																move(index, -1);
															},
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconArrowUp, { size: 12 })
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: "dl-mini",
															title: "下移",
															onClick: () => {
																move(index, 1);
															},
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconArrowDown, { size: 12 })
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
															type: "button",
															className: "dl-mini dl-mini-stop",
															title: "删除",
															onClick: () => {
																setDrafts((current) => current.filter((_, i) => i !== index));
															},
															children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconClose, { size: 12 })
														})
													]
												})
											]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: "dl-form-command",
											value: draft.command,
											placeholder: "命令（如 pnpm dev）",
											spellCheck: false,
											onChange: (e) => {
												update(index, { command: e.target.value });
											}
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dl-form-line3",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "dl-form-cwd",
												value: draft.cwd,
												placeholder: "工作目录（相对项目根，可空）",
												spellCheck: false,
												onChange: (e) => {
													update(index, { cwd: e.target.value });
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "dl-form-cwd",
												value: draft.readyUrlText,
												placeholder: "就绪检测 URL（可空，如 http://localhost:3000）",
												spellCheck: false,
												title: "轮询该地址，任意 HTTP 响应即标记「就绪」",
												onChange: (e) => {
													update(index, { readyUrlText: e.target.value });
												}
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dl-form-line4",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
												className: "dl-form-env",
												value: draft.envText,
												placeholder: "环境变量 每行 KEY=VALUE（可空）",
												spellCheck: false,
												rows: 2,
												onChange: (e) => {
													update(index, { envText: e.target.value });
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
												className: "dl-form-opt dl-switch",
												title: "异常退出后自动重启（指数退避，最多 5 次；手动停止不会触发）",
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "checkbox",
														checked: draft.autoRestart,
														onChange: (e) => {
															update(index, { autoRestart: e.target.checked });
														}
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dl-switch-track" }),
													"崩溃自动重启"
												]
											})]
										})
									]
								}, draft.id)),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dl-profiles-card",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dl-profiles-head",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconLayers, { size: 13 }),
											"启动预设",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontWeight: 400,
													fontSize: 11,
													color: "var(--dsw-alias-label-tertiary)"
												},
												children: "一键启动可切换为预设组合，并自动停止预设外的运行组"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: "dl-add-btn",
												onClick: () => {
													setProfileDrafts((current) => [...current, {
														id: newGroupId(),
														label: "",
														members: []
													}]);
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlus, { size: 11 }), "预设"]
											})
										]
									}), profileDrafts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dl-profiles-empty",
										children: "还没有预设。添加一个「仅前端」，一键启动时就只拉起选中的组。"
									}) : profileDrafts.map((profile, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dl-profile-row",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dl-profile-line1",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "dl-profile-name",
												value: profile.label,
												placeholder: "预设名（如 仅前端）",
												onChange: (e) => {
													updateProfile(index, { label: e.target.value });
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dl-form-order",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dl-mini dl-mini-stop",
													title: "删除预设",
													onClick: () => {
														setProfileDrafts((current) => current.filter((_, i) => i !== index));
													},
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconClose, { size: 12 })
												})
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											className: "dl-profile-members",
											children: drafts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dl-profiles-empty",
												children: "先添加启动组"
											}) : drafts.map((draft) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: "dl-member-chip",
												"data-on": profile.members.includes(draft.id) || void 0,
												onClick: () => {
													toggleMember(index, draft.id);
												},
												children: draft.label === "" ? draft.id : draft.label
											}, draft.id))
										})]
									}, profile.id))]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dl-form-adds",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dl-add-btn",
											"data-kind": "frontend",
											onClick: () => {
												setDrafts((current) => [...current, emptyDraft("frontend")]);
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlus, { size: 11 }), "前端"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dl-add-btn",
											"data-kind": "backend",
											onClick: () => {
												setDrafts((current) => [...current, emptyDraft("backend")]);
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlus, { size: 11 }), "后端"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dl-add-btn",
											"data-kind": "other",
											onClick: () => {
												setDrafts((current) => [...current, emptyDraft("other")]);
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlus, { size: 11 }), "其他"]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											className: "dl-add-btn",
											"data-import": "",
											onClick: () => {
												loadSuggests();
											},
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconImport, { size: 12 }), "从 package.json 导入"]
										})
									]
								}),
								showSuggests ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: "dl-suggest",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dl-suggest-head",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "package.json scripts（含子目录）" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dl-mini",
											onClick: () => {
												setShowSuggests(false);
											},
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconClose, { size: 12 })
										})]
									}), suggests.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dl-suggest-empty",
										children: "项目内没有找到 package.json scripts"
									}) : suggests.map((s) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dl-suggest-row",
										onClick: () => {
											applySuggest(s);
										},
										title: s.cwd === "" ? s.command : `${s.cwd} → ${s.command}`,
										children: [
											s.cwd === "" ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: "dl-suggest-cwd",
												children: s.cwd
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: "dl-suggest-name",
												children: s.name
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
												className: "dl-suggest-cmd",
												children: s.command
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dl-suggest-add",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlus, { size: 10 }), "添加"]
											})
										]
									}, `${s.cwd}/${s.name}`))]
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-modal-foot",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dl-modal-note",
									children: "配置按项目保存，同项目的所有会话共享。"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dl-foot-btn",
									onClick: close,
									children: "取消"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dl-foot-btn dl-foot-go",
									disabled: saving,
									onClick: () => {
										save();
									},
									children: saving ? "保存中…" : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheck, { size: 12 }), "保存"] })
								})
							]
						})
					]
				})
			}), document.body);
		}

		//#endregion
		//#region src/client/console-view.tsx
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
		/** Strip ANSI CSI/OSC sequences for plain rendering. */
		function stripAnsi(text) {
			return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "");
		}
		/** Duration text for a running process. */
		function durationText(startedAt, now) {
			if (startedAt === void 0) return "";
			const total = Math.max(0, Math.floor((now - startedAt) / 1e3));
			const h = Math.floor(total / 3600);
			const m = Math.floor(total % 3600 / 60);
			const s = total % 60;
			if (h > 0) return `${h}h${m}m`;
			if (m > 0) return `${m}m${s}s`;
			return `${s}s`;
		}
		/** Kind label. */
		function kindLabel$1(kind) {
			if (kind === "frontend") return "前端";
			if (kind === "backend") return "后端";
			return "其他";
		}
		/** Status dot class. */
		function dotClass$1(run) {
			if (run?.status === "running") return run.ready === true ? "dl-dot dl-dot-ready" : "dl-dot dl-dot-on";
			if (run?.status === "exited" && (run.exitCode ?? 0) !== 0) return "dl-dot dl-dot-err";
			return "dl-dot dl-dot-off";
		}
		/** Render text with the first search match highlighted (case-insensitive). */
		function Highlight(props) {
			const { text, query } = props;
			if (query === "") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: text });
			const index = text.toLowerCase().indexOf(query);
			if (index < 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: text });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				text.slice(0, index),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("mark", {
					className: "dl-mark",
					children: text.slice(index, index + query.length)
				}),
				text.slice(index + query.length)
			] });
		}
		/** One rendered output line. */
		function Line(props) {
			const text = stripAnsi(props.line.text);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: props.line.stream === "err" ? "dl-line dl-line-err" : "dl-line",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dl-line-seq",
					children: props.line.seq
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dl-line-text",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Highlight, {
						text,
						query: props.query
					})
				})]
			});
		}
		/** The console view component. */
		function ConsoleView(props) {
			const { controller, sessionId, resolveWorkspace } = props;
			const workspaceId = resolveWorkspace(sessionId);
			const version = (0, react.useSyncExternalStore)((0, react.useCallback)((cb) => controller.subscribe(cb), [controller]), () => consoleVersion(controller, workspaceId));
			const view = workspaceId === void 0 ? void 0 : controller.view(workspaceId);
			const [selected, setSelected] = (0, react.useState)(void 0);
			const [follow, setFollow] = (0, react.useState)(true);
			const [now, setNow] = (0, react.useState)(() => Date.now());
			const [query, setQuery] = (0, react.useState)("");
			const [errOnly, setErrOnly] = (0, react.useState)(false);
			const [copied, setCopied] = (0, react.useState)(false);
			const scrollRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (workspaceId === void 0) return;
				return controller.acquire(workspaceId);
			}, [controller, workspaceId]);
			const groups = (0, react.useMemo)(() => view?.config.groups ?? [], [view]);
			const runs = view?.runs ?? {};
			const runningCount = (0, react.useMemo)(() => groups.filter((group) => (runs[group.id]?.status ?? "stopped") === "running").length, [groups, runs]);
			const effectiveSelected = selected !== void 0 && groups.some((g) => g.id === selected) ? selected : groups[0]?.id;
			const lines = (0, react.useMemo)(() => workspaceId === void 0 || effectiveSelected === void 0 ? [] : view?.lines.get(effectiveSelected) ?? [], [
				view,
				effectiveSelected,
				workspaceId
			]);
			const normalizedQuery = query.trim().toLowerCase();
			const filtering = normalizedQuery !== "" || errOnly;
			const visible = (0, react.useMemo)(() => {
				if (!filtering) return lines;
				return lines.filter((line) => (!errOnly || line.stream === "err") && (normalizedQuery === "" || stripAnsi(line.text).toLowerCase().includes(normalizedQuery)));
			}, [
				lines,
				filtering,
				errOnly,
				normalizedQuery
			]);
			(0, react.useEffect)(() => {
				const timer = setInterval(() => {
					setNow(Date.now());
				}, 1e3);
				return () => {
					clearInterval(timer);
				};
			}, []);
			(0, react.useEffect)(() => {
				if (!follow) return;
				const el = scrollRef.current;
				if (el === null) return;
				el.scrollTop = el.scrollHeight;
			}, [
				follow,
				visible.length,
				version
			]);
			(0, react.useEffect)(() => {
				setFollow(true);
				setQuery("");
				setErrOnly(false);
			}, [effectiveSelected]);
			/** Detect user scroll away from the bottom. */
			const onScroll = () => {
				const el = scrollRef.current;
				if (el === null) return;
				const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
				if (atBottom !== follow) setFollow(atBottom);
			};
			const selectedGroup = groups.find((g) => g.id === effectiveSelected);
			const selectedRun = effectiveSelected === void 0 ? void 0 : runs[effectiveSelected];
			const conflicts = (0, react.useMemo)(() => portConflicts(runs), [runs]);
			/** Copy the visible (filtered) output to the clipboard. */
			const copyOutput = (0, react.useCallback)(() => {
				if (visible.length === 0) return;
				if (navigator.clipboard === void 0) return;
				const text = visible.map((l) => stripAnsi(l.text)).join("\n");
				navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					window.setTimeout(() => {
						setCopied(false);
					}, 1500);
				}, () => {});
			}, [visible]);
			/** Download the visible (filtered) output as a .log file. */
			const exportOutput = (0, react.useCallback)(() => {
				if (selectedGroup === void 0 || visible.length === 0) return;
				const header = [
					`# devlaunch export — ${selectedGroup.label}`,
					`# command: ${selectedGroup.command}`,
					`# exported: ${(/* @__PURE__ */ new Date()).toISOString()}`,
					`# lines: ${visible.length}`,
					""
				].join("\n");
				const body = visible.map((l) => `[${l.stream === "err" ? "err" : "out"}] ${stripAnsi(l.text)}`).join("\n");
				const blob = new Blob([header + body + "\n"], { type: "text/plain;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const anchor = document.createElement("a");
				const slug = selectedGroup.label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
				anchor.href = url;
				anchor.download = `${slug === "" ? "devlaunch" : slug}.log`;
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				window.setTimeout(() => {
					URL.revokeObjectURL(url);
				}, 1e3);
			}, [selectedGroup, visible]);
			/** Act with silent error swallow (console already shows state). */
			const act = (0, react.useCallback)((fn) => {
				if (workspaceId === void 0) return;
				fn().catch(() => {});
			}, [workspaceId]);
			const connected = view?.connected ?? false;
			const restartSuffix = (selectedRun?.restarts ?? 0) > 0 ? ` · 已重启${selectedRun?.restarts}` : "";
			const chip = selectedRun?.status === "running" ? {
				state: "running",
				text: (selectedRun.ready === true ? "已就绪" : "运行中") + ` · ${durationText(selectedRun.startedAt, now)}${restartSuffix}`
			} : selectedRun?.status === "exited" && ((selectedRun.exitCode ?? 0) !== 0 || selectedRun.error !== void 0) ? {
				state: "error",
				text: selectedRun.error ?? (selectedRun.stoppedByUser ? "已停止" : `退出码 ${selectedRun.exitCode ?? "?"}`)
			} : {
				state: "idle",
				text: selectedRun?.status === "exited" ? "已停止" : "未运行"
			};
			const selectedPorts = selectedRun?.ports ?? [];
			const selectedConflictPort = effectiveSelected === void 0 ? void 0 : conflicts.get(effectiveSelected);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dl-console-root",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dl-console-rail",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-rail-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "启动组" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: connected ? "dl-conn dl-conn-on" : "dl-conn",
								title: connected ? "已连接" : "未连接",
								children: "●"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dl-rail-list",
							role: "tablist",
							"aria-label": "启动组",
							children: groups.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dl-rail-empty",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminal, { size: 22 }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "尚未配置启动命令" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										className: "dl-rail-config",
										onClick: () => {
											window.dispatchEvent(new CustomEvent("dsh-devlaunch:config", { detail: { workspaceId } }));
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconGear, { size: 11 }), "去配置"]
									})
								]
							}) : groups.map((group) => {
								const run = runs[group.id];
								const running = run?.status === "running";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "tab",
									"aria-selected": group.id === effectiveSelected,
									className: group.id === effectiveSelected ? "dl-rail-item dl-rail-item-on" : "dl-rail-item",
									"data-conflict": conflicts.get(group.id) !== void 0 || void 0,
									title: conflicts.get(group.id) !== void 0 ? `端口冲突：${conflicts.get(group.id)} 被多个运行中的组占用` : void 0,
									onClick: () => {
										setSelected(group.id);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: dotClass$1(run) }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dl-kind",
											"data-kind": group.kind,
											children: kindLabel$1(group.kind)
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dl-rail-label",
											children: group.label
										}),
										(run?.restarts ?? 0) > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dl-restart-badge",
											title: `异常退出后已自动重启 ${run?.restarts} 次`,
											children: ["↻$", run?.restarts]
										}) : null,
										running ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: run?.ready === true ? "dl-rail-dur dl-rail-dur-run" : "dl-rail-dur",
											children: [run?.ready === true ? "✓ " : "", durationText(run?.startedAt, now)]
										}) : run?.status === "exited" && (run.exitCode ?? 0) !== 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dl-rail-dur dl-rail-dur-err",
											title: run.error ?? "",
											children: "异常"
										}) : null
									]
								}, group.id);
							})
						}),
						groups.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-rail-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dl-rail-foot-btn dl-rail-foot-go",
								onClick: () => {
									act(() => controller.start(workspaceId));
								},
								title: "启动全部启用的组",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, { size: 9 }), "全部启动"]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dl-rail-foot-btn dl-rail-foot-stop",
								disabled: runningCount === 0,
								onClick: () => {
									act(() => controller.stop(workspaceId));
								},
								title: "停止全部运行中的组",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStop, { size: 8 }), "全部停止"]
							})]
						}) : null
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dl-console-main",
					children: selectedGroup === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dl-console-empty",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminal, { size: 26 }), "选择左侧启动组查看输出"]
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-console-bar",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dl-console-title",
									children: selectedGroup.label
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: "dl-console-cmd",
									title: selectedGroup.command,
									children: selectedGroup.command
								}),
								selectedGroup.cwd !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: "dl-console-cwd",
									children: selectedGroup.cwd
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dl-chip",
									"data-state": chip.state,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: dotClass$1(selectedRun) }), chip.text]
								}),
								selectedPorts.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dl-ports",
									children: selectedPorts.slice(0, 4).map((port) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
										className: "dl-port-chip",
										href: `http://localhost:${port}`,
										target: "_blank",
										rel: "noreferrer noopener",
										"data-conflict": selectedConflictPort === port || void 0,
										title: selectedConflictPort === port ? `端口冲突：${port} 被多个运行中的组占用` : `打开 http://localhost:${port}`,
										children: [
											":$",
											port,
											"↗"
										]
									}, port))
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dl-console-actions",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dl-mini dl-mini-go",
											disabled: selectedRun?.status === "running",
											onClick: () => {
												act(() => controller.start(workspaceId, [selectedGroup.id]));
											},
											title: "启动",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, { size: 12 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dl-mini dl-mini-stop",
											disabled: selectedRun?.status !== "running",
											onClick: () => {
												act(() => controller.stop(workspaceId, [selectedGroup.id]));
											},
											title: "停止",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStop, { size: 10 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dl-mini dl-mini-restart",
											onClick: () => {
												act(() => controller.restart(workspaceId, selectedGroup.id));
											},
											title: "重启",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRestart, { size: 13 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: copied ? "dl-mini dl-mini-copy dl-mini-copy-done" : "dl-mini dl-mini-copy",
											disabled: visible.length === 0,
											onClick: copyOutput,
											title: copied ? "已复制" : "复制输出",
											children: copied ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCheck, { size: 13 }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconCopy, { size: 13 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dl-mini dl-mini-copy",
											disabled: visible.length === 0,
											onClick: exportOutput,
											title: "导出为 .log 文件",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconExport, { size: 13 })
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: "dl-mini",
											disabled: lines.length === 0,
											onClick: () => {
												controller.clearLines(workspaceId, selectedGroup.id);
											},
											title: "清屏",
											children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTrash, { size: 13 })
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "dl-toggle-btn",
									"aria-pressed": errOnly,
									title: "只显示 stderr 输出",
									onClick: () => {
										setErrOnly((current) => !current);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconFunnel, { size: 11 }), "仅错误"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dl-search-wrap",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSearch, { size: 12 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: "dl-search",
										value: query,
										placeholder: "搜索输出…",
										spellCheck: false,
										onChange: (e) => {
											setQuery(e.target.value);
										},
										onKeyDown: (e) => {
											if (e.key === "Escape") setQuery("");
										}
									})]
								}),
								filtering ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dl-filter-count",
									title: "过滤后 / 总行数",
									children: [
										visible.length,
										"/",
										lines.length,
										" 行"
									]
								}) : null
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dl-console-scroll",
							ref: scrollRef,
							onScroll,
							children: visible.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dl-console-nooutput",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminal, { size: 24 }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: filtering ? "没有匹配的输出" : "暂无输出" })]
							}) : visible.map((line) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Line, {
								line,
								query: normalizedQuery
							}, line.seq))
						}),
						!follow ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dl-follow-btn",
							onClick: () => {
								setFollow(true);
							},
							children: "↓ 回到底部"
						}) : null
					] })
				})]
			});
		}
		/** Snapshot token for the console view. */
		function consoleVersion(controller, workspaceId) {
			if (workspaceId === void 0) return 0;
			const view = controller.view(workspaceId);
			if (view === void 0) return 0;
			let hash = view.connected ? 7 : 0;
			for (const run of Object.values(view.runs)) hash = hash * 31 + run.status.length + (run.exitCode ?? 0) | 0;
			for (const lines of view.lines.values()) hash = hash * 31 + lines.length | 0;
			hash = hash * 31 + view.config.groups.length * 17 | 0;
			return hash;
		}

		//#endregion
		//#region src/client/launch-button.tsx
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
		/** Status dot color for a run state. */
		function dotClass(run) {
			if (run === void 0) return "dl-dot dl-dot-off";
			if (run.status === "running") return run.ready === true ? "dl-dot dl-dot-ready" : "dl-dot dl-dot-on";
			if (run.status === "exited" && (run.exitCode ?? 0) !== 0) return "dl-dot dl-dot-err";
			return "dl-dot dl-dot-off";
		}
		/** Short status text. */
		function statusText(run) {
			if (run === void 0) return "未运行";
			if (run.status === "running") {
				const base = run.ready === true ? "就绪" : "运行中";
				return (run.restarts ?? 0) > 0 ? `${base} · 已重启${run.restarts}` : base;
			}
			if (run.error !== void 0) return run.error;
			if (run.status === "exited") {
				if (run.stoppedByUser) return "已停止";
				return `退出码 ${run.exitCode ?? "?"}`;
			}
			return "未运行";
		}
		/** One dropdown row. */
		function GroupRow(props) {
			const { group, run, running, conflictPort } = props;
			const status = statusText(run);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dl-menu-row",
				"data-running": running || void 0,
				"data-conflict": conflictPort !== void 0 || void 0,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: dotClass(run) }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dl-kind",
						"data-kind": group.kind,
						children: kindLabel(group.kind)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dl-row-label",
						title: `${group.command}${group.cwd === "" ? "" : `  (${group.cwd})`}`,
						children: group.label
					}),
					conflictPort !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dl-restart-badge",
						title: `端口冲突：${conflictPort} 被多个运行中的组占用`,
						children: ["⚠ :$", conflictPort]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: run?.ready === true ? "dl-row-status dl-status-ready" : "dl-row-status",
						title: status,
						children: status
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dl-row-actions",
						children: running ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dl-mini dl-mini-restart",
							title: "重启",
							onClick: props.onRestart,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconRestart, { size: 13 })
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dl-mini dl-mini-stop",
							title: "停止",
							onClick: props.onStop,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStop, { size: 11 })
						})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dl-mini dl-mini-go",
							title: "启动",
							onClick: props.onStart,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, { size: 12 })
						})
					})
				]
			});
		}
		/** Kind chip text. */
		function kindLabel(kind) {
			if (kind === "frontend") return "前端";
			if (kind === "backend") return "后端";
			return "其他";
		}
		/** The header button component. */
		function LaunchButton(props) {
			const { controller, sessionId, resolveWorkspace } = props;
			const workspaceId = resolveWorkspace(sessionId);
			(0, react.useSyncExternalStore)((0, react.useCallback)((cb) => controller.subscribe(cb), [controller]), () => `${controllerVersion(controller, workspaceId)}:${workspaceId === void 0 ? "" : controller.selectedProfile(workspaceId)}`);
			const view = workspaceId === void 0 ? void 0 : controller.view(workspaceId);
			const [open, setOpen] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (workspaceId === void 0) return;
				return controller.acquire(workspaceId);
			}, [controller, workspaceId]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const close = (event) => {
					if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) setOpen(false);
				};
				document.addEventListener("pointerdown", close);
				return () => {
					document.removeEventListener("pointerdown", close);
				};
			}, [open]);
			const groups = (0, react.useMemo)(() => view?.config.groups ?? [], [view]);
			const profiles = (0, react.useMemo)(() => view?.config.profiles ?? [], [view]);
			const runs = view?.runs ?? {};
			const runningCount = (0, react.useMemo)(() => groups.filter((group) => (runs[group.id]?.status ?? "stopped") === "running").length, [groups, runs]);
			const hasGroups = groups.length > 0;
			const conflicts = (0, react.useMemo)(() => portConflicts(runs), [runs]);
			const profileSel = workspaceId === void 0 ? "" : controller.selectedProfile(workspaceId);
			const target = workspaceId === void 0 ? void 0 : controller.profileTarget(workspaceId);
			const targetLabel = target?.profileId === "" ? "全部" : target?.label ?? "全部";
			/** Run an action with busy/error handling. */
			const act = (0, react.useCallback)(async (fn) => {
				if (workspaceId === void 0) return;
				setBusy(true);
				setError(void 0);
				try {
					await fn();
				} catch (e) {
					setError(e instanceof Error ? e.message : String(e));
				} finally {
					setBusy(false);
				}
			}, [workspaceId]);
			const mainAction = () => {
				if (!hasGroups) {
					setOpen(true);
					return;
				}
				if (runningCount > 0) act(() => controller.stop(workspaceId));
				else act(() => controller.startTarget(workspaceId));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dl-root",
				ref: rootRef,
				onKeyDown: (e) => {
					if (e.key === "Escape") setOpen(false);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: busy || workspaceId === void 0 ? "dl-pill dl-pill-disabled" : "dl-pill",
					"data-state": runningCount > 0 ? "running" : hasGroups ? "idle" : "empty",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dl-trigger",
							"aria-expanded": open,
							"aria-label": runningCount > 0 ? `停止 ${runningCount} 个服务` : "一键启动",
							title: workspaceId === void 0 ? "正在解析项目…" : runningCount > 0 ? "一键停止" : `一键启动「${targetLabel}」`,
							disabled: busy || workspaceId === void 0,
							onClick: mainAction,
							children: runningCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dl-dot dl-dot-on" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["停止 ", runningCount] })] }) : hasGroups ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dl-pill-ico",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, { size: 11 })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "启动" })] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dl-pill-ico",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconGear, { size: 12 })
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "启动配置" })] })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dl-pill-div" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dl-caret-btn",
							"aria-label": "启动菜单",
							"aria-expanded": open,
							disabled: workspaceId === void 0,
							onClick: () => {
								setOpen((current) => !current);
							},
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconChevron, {
								size: 12,
								className: open ? "dl-caret-flip" : void 0
							})
						})
					]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dl-menu",
					role: "menu",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-menu-head",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dl-menu-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminal, { size: 12 }), "启动组"]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dl-menu-config",
								onClick: () => {
									setOpen(false);
									window.dispatchEvent(new CustomEvent("dsh-devlaunch:config", { detail: { workspaceId } }));
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconGear, { size: 11 }), "配置…"]
							})]
						}),
						error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: "dl-menu-error",
							role: "alert",
							children: error
						}) : null,
						profiles.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-profile-bar",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dl-profile-label",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconLayers, { size: 11 }), "预设"]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dl-profile-chip",
									"data-on": profileSel === "" || void 0,
									title: "一键启动 = 全部启用的组",
									onClick: () => {
										controller.setSelectedProfile(workspaceId, "");
									},
									children: "全部"
								}),
								profiles.map((profile) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dl-profile-chip",
									"data-on": profileSel === profile.id || void 0,
									title: `一键启动 = ${profile.label}（${profile.groupIds.length} 组），并停止预设外的运行组`,
									onClick: () => {
										controller.setSelectedProfile(workspaceId, profile.id);
									},
									children: profile.label
								}, profile.id))
							]
						}) : null,
						hasGroups ? groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupRow, {
							group,
							run: runs[group.id],
							running: (runs[group.id]?.status ?? "stopped") === "running",
							conflictPort: conflicts.get(group.id),
							onStart: () => {
								act(() => controller.start(workspaceId, [group.id]));
							},
							onStop: () => {
								act(() => controller.stop(workspaceId, [group.id]));
							},
							onRestart: () => {
								act(() => controller.restart(workspaceId, group.id));
							}
						}, group.id)) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-menu-empty",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconTerminal, { size: 22 }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"尚未配置启动命令。",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
									"点击「配置…」添加前端 / 后端命令。"
								] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: "dl-rail-config",
									onClick: () => {
										setOpen(false);
										window.dispatchEvent(new CustomEvent("dsh-devlaunch:config", { detail: { workspaceId } }));
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconGear, { size: 11 }), "去配置"]
								})
							]
						}),
						hasGroups ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dl-menu-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dl-foot-btn dl-foot-go",
								disabled: busy,
								onClick: () => {
									act(() => controller.startTarget(workspaceId));
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconPlay, { size: 10 }),
									"启动「",
									targetLabel,
									"」"
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dl-foot-btn dl-foot-danger",
								disabled: busy || runningCount === 0,
								onClick: () => {
									act(() => controller.stop(workspaceId));
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconStop, { size: 9 }), "全部停止"]
							})]
						}) : null
					]
				}) : null]
			});
		}
		/** Snapshot token for useSyncExternalStore (changes whenever the view does). */
		function controllerVersion(controller, workspaceId) {
			if (workspaceId === void 0) return 0;
			const view = controller.view(workspaceId);
			if (view === void 0) return 0;
			let hash = view.connected ? 1 : 0;
			for (const run of Object.values(view.runs)) hash = hash * 31 + run.status.length + (run.exitCode ?? 0) | 0;
			for (const lines of view.lines.values()) hash = hash * 31 + lines.length | 0;
			hash = hash * 31 + view.config.groups.length | 0;
			return hash;
		}

		//#endregion
		//#region src/client/index.tsx
		/** Client plugin name. */
		const name = "dsh-devlaunch/client";
		/** Required services (fiber inject waiting): slots for registration + sessions for the workspace map. */
		const inject = ["slots", "sessions"];
		/** Mount the client half. */
		function apply(ctx) {
			try {
				injectStyles();
				const controller = new DevlaunchController();
				const workspaces = () => ctx.get?.("workspaces");
				/** Resolve the workspace id owning a session, lazily per render. */
				const resolveWorkspace = (sessionId) => {
					const ws = workspaces();
					if (ws !== void 0) try {
						const items = ws.list.getSnapshot().items;
						if (Array.isArray(items)) {
							for (const item of items) if (item.sessionIds.includes(sessionId)) return item.workspaceId;
						}
					} catch {}
				};
				const slots = ctx.get?.("slots");
				if (slots !== void 0) {
					slots.inject("conversation.session.header.actions", () => slots.register({
						name: "conversation.session.header.actions",
						id: "devlaunch-button",
						order: 30,
						inject: () => ({
							controller,
							resolveWorkspace
						})
					}, LaunchButton));
					slots.inject("conversation.view", () => slots.register({
						name: "conversation.view",
						id: "dev-console",
						order: 10,
						label: () => "控制台",
						inject: (sessionId) => ({
							controller,
							resolveWorkspace,
							sessionId
						})
					}, ConsoleView));
				}
				let modalRoot;
				const host = document.createElement("div");
				host.dataset.dshDevlaunchModal = "";
				document.body.appendChild(host);
				modalRoot = (0, react_dom_client.createRoot)(host);
				modalRoot.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ConfigModal, { controller }));
				ctx.effect?.(() => () => {
					modalRoot?.unmount();
					host.remove();
					controller.dispose();
				}, "dsh-devlaunch: client mount");
			} catch (error) {
				console.error("[dsh-devlaunch] client half failed to start:", error);
			}
		}

		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
