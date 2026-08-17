//#region src/shared/protocol.ts
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const LABEL_MAX = 60;
const COMMAND_MAX = 2e3;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Max groups per workspace — a sanity ceiling, not a UX target. */
const MAX_GROUPS = 32;
/** Max launch presets per workspace. */
const MAX_PROFILES = 8;
/** Max member ids kept per profile after validation. */
const MAX_PROFILE_MEMBERS = 32;
/** Is this a valid group kind on the wire? */
function isGroupKind(value) {
	return value === "frontend" || value === "backend" || value === "other";
}
/** New opaque group id. */
function newGroupId() {
	return `g-${Math.random().toString(36).slice(2, 10)}`;
}
/** Normalize a relative cwd: strip leading ./, backslashes → /, no .. escape. */
function normalizeCwd(raw) {
	if (typeof raw !== "string") return "";
	let value = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (value === ".") value = "";
	const segs = [];
	for (const seg of value.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (segs.length === 0) throw new Error("cwd 不能越出项目根目录（含 ..）");
			segs.pop();
			continue;
		}
		segs.push(seg);
	}
	return segs.join("/");
}
/** Normalize + validate one launch group from untrusted JSON. Throws on violation. */
function normalizeGroup(raw) {
	if (typeof raw !== "object" || raw === null) throw new Error("启动组必须是对象");
	const body = raw;
	const id = typeof body.id === "string" && ID_RE.test(body.id) ? body.id : newGroupId();
	const kind = isGroupKind(body.kind) ? body.kind : "other";
	let label = typeof body.label === "string" ? body.label.trim() : "";
	if (label.length === 0) label = kind === "frontend" ? "前端" : kind === "backend" ? "后端" : "命令";
	if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX);
	const command = typeof body.command === "string" ? body.command.trim() : "";
	if (command.length === 0) throw new Error("启动命令不能为空");
	if (command.length > COMMAND_MAX) throw new Error("启动命令过长");
	const cwd = normalizeCwd(body.cwd);
	const env = {};
	if (body.env !== void 0) {
		if (typeof body.env !== "object" || body.env === null || Array.isArray(body.env)) throw new Error("env 必须是对象");
		for (const [key, value] of Object.entries(body.env)) {
			if (!ENV_KEY_RE.test(key)) throw new Error(`env 变量名非法: ${key}`);
			if (typeof value !== "string") throw new Error(`env 变量 ${key} 的值必须是字符串`);
			env[key] = value;
		}
	}
	let readyUrl;
	if (body.readyUrl !== void 0 && body.readyUrl !== null && typeof body.readyUrl === "string" && body.readyUrl.trim() !== "") {
		if (typeof body.readyUrl !== "string") throw new Error("readyUrl 必须是字符串");
		const candidate = body.readyUrl.trim();
		let parsed;
		try {
			parsed = new URL(candidate);
		} catch {
			throw new Error("readyUrl 必须是合法的绝对 URL（如 http://localhost:3000）");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("readyUrl 仅支持 http(s) 地址");
		readyUrl = candidate;
	}
	return {
		id,
		kind,
		label,
		command,
		cwd,
		env,
		enabled: body.enabled !== false,
		readyUrl,
		autoRestart: body.autoRestart === true
	};
}
/** Normalize + validate a whole workspace config record. */
function normalizeWorkspaceConfig(raw) {
	if (typeof raw !== "object" || raw === null) throw new Error("工作区配置必须是对象");
	const body = raw;
	const rawGroups = Array.isArray(body.groups) ? body.groups : [];
	if (rawGroups.length > MAX_GROUPS) throw new Error(`启动组数量超过上限 ${MAX_GROUPS}`);
	const groups = rawGroups.map((g) => normalizeGroup(g));
	const seen = /* @__PURE__ */ new Set();
	for (const group of groups) {
		if (seen.has(group.id)) throw new Error(`启动组 id 重复: ${group.id}`);
		seen.add(group.id);
	}
	const groupIds = new Set(groups.map((g) => g.id));
	const rawProfiles = Array.isArray(body.profiles) ? body.profiles.slice(0, MAX_PROFILES) : [];
	const profiles = [];
	const seenProfile = /* @__PURE__ */ new Set();
	for (const item of rawProfiles) {
		if (typeof item !== "object" || item === null) continue;
		const profile = item;
		const id = typeof profile.id === "string" && ID_RE.test(profile.id) ? profile.id : newGroupId();
		if (seenProfile.has(id)) continue;
		let label = typeof profile.label === "string" ? profile.label.trim() : "";
		if (label.length === 0) label = "预设";
		if (label.length > LABEL_MAX) label = label.slice(0, LABEL_MAX);
		const members = [];
		if (Array.isArray(profile.groupIds)) for (const value of profile.groupIds) {
			if (typeof value !== "string") continue;
			if (!groupIds.has(value) || members.includes(value)) continue;
			if (members.length >= MAX_PROFILE_MEMBERS) break;
			members.push(value);
		}
		seenProfile.add(id);
		profiles.push({
			id,
			label,
			groupIds: members
		});
	}
	return {
		groups,
		profiles
	};
}
/** Parse the whole config file (tolerant: missing/corrupt → empty config). */
function parseConfigFile(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {
			schemaVersion: 1,
			workspaces: {}
		};
	}
	if (typeof parsed !== "object" || parsed === null) return {
		schemaVersion: 1,
		workspaces: {}
	};
	const body = parsed;
	const workspaces = {};
	if (typeof body.workspaces === "object" && body.workspaces !== null) for (const [id, value] of Object.entries(body.workspaces)) try {
		workspaces[id] = normalizeWorkspaceConfig(value);
	} catch {}
	return {
		schemaVersion: 1,
		workspaces
	};
}
/** Serialize the config file (stable key order for readable diffs). */
function serializeConfigFile(file) {
	const out = {
		schemaVersion: 1,
		workspaces: Object.fromEntries(Object.entries(file.workspaces).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, ws]) => [id, {
			groups: ws.groups.map((g) => ({
				...g,
				env: { ...g.env }
			})),
			profiles: ws.profiles.map((p) => ({
				id: p.id,
				label: p.label,
				groupIds: [...p.groupIds]
			}))
		}]))
	};
	return `${JSON.stringify(out, null, 2)}\n`;
}
//#endregion
export { isGroupKind, newGroupId, normalizeCwd, normalizeGroup, normalizeWorkspaceConfig, parseConfigFile, serializeConfigFile };

//# sourceMappingURL=protocol.js.map