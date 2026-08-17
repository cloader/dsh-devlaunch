import { normalizeWorkspaceConfig, parseConfigFile, serializeConfigFile } from "../shared/protocol.js";
import { dshHomePath } from "../invariant.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
//#region src/host/config.ts
/**
* ConfigStore: load/normalize/persist the per-workspace launch configs at
* ~/.dsh/dsh-devlaunch.json. Atomic write (tmp + rename). Single writer is
* the host process; readers get frozen snapshots.
*
* @module dsh-devlaunch/host/config
*/
/**
* The store. All mutations go through replaceWorkspace / clearWorkspace so
* validation and serialization stay centralized.
*/
var ConfigStore = class {
	file;
	data;
	constructor(options = {}) {
		this.file = options.file ?? dshHomePath("dsh-devlaunch.json");
		this.data = this.load();
	}
	/** Read + normalize from disk (tolerant of corruption). */
	load() {
		try {
			return parseConfigFile(readFileSync(this.file, "utf8"));
		} catch {
			return {
				schemaVersion: 1,
				workspaces: {}
			};
		}
	}
	/** Persist atomically. */
	persist() {
		const dir = dirname(this.file);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmp = `${this.file}.tmp`;
		writeFileSync(tmp, serializeConfigFile(this.data), "utf8");
		renameSync(tmp, this.file);
	}
	/** Frozen snapshot of one workspace config (empty when unconfigured). */
	get(workspaceId) {
		return this.data.workspaces[workspaceId] ?? Object.freeze({
			groups: [],
			profiles: []
		});
	}
	/** All configured workspace ids. */
	ids() {
		return Object.keys(this.data.workspaces);
	}
	/**
	* Validate + install a whole workspace config. Throws on invalid input.
	* @returns the normalized config.
	*/
	replaceWorkspace(workspaceId, raw) {
		const normalized = normalizeWorkspaceConfig(raw);
		const workspaces = {
			...this.data.workspaces,
			[workspaceId]: normalized
		};
		this.data = {
			schemaVersion: 1,
			workspaces
		};
		this.persist();
		return normalized;
	}
	/** Forget a workspace's config. */
	clearWorkspace(workspaceId) {
		if (!(workspaceId in this.data.workspaces)) return;
		const workspaces = { ...this.data.workspaces };
		delete workspaces[workspaceId];
		this.data = {
			schemaVersion: 1,
			workspaces
		};
		this.persist();
	}
};
//#endregion
export { ConfigStore };

//# sourceMappingURL=config.js.map