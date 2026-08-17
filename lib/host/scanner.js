import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
//#region src/host/scanner.ts
/**
* package.json script scanner: walks the workspace (root + subdirectories)
* for package.json manifests and projects their scripts as import
* suggestions. Monorepo-aware — `packages/web` and `packages/api` each
* contribute their own rows, carrying their relative cwd so an imported
* group actually runs in the right directory.
*
* Walk policy:
* - skips dependency/build directories (node_modules, dist, build, out,
*   coverage, target, vendor, bower_components) and every dot-directory
*   (.git, .next, .cache …) — symlinked directories are skipped naturally
*   (Dirent.isDirectory() is false for symlinks), which also breaks cycles
* - depth cap (default 3 levels below the root) and package count cap
*   (default 50) keep giant trees cheap
* - a corrupt or unreadable manifest is skipped silently: one bad
*   package.json must never fail the whole scan
*
* @module dsh-devlaunch/host/scanner
*/
/** Directory names never descended into. */
const SKIP_DIRS = /* @__PURE__ */ new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"vendor",
	"bower_components"
]);
/** Default walk depth below the workspace root. */
const DEFAULT_MAX_DEPTH = 3;
/** Default cap on discovered packages per scan. */
const DEFAULT_MAX_PACKAGES = 50;
/** Parse one manifest's scripts (empty on any error). */
function scriptsOf(raw) {
	try {
		const scripts = JSON.parse(raw).scripts;
		if (typeof scripts !== "object" || scripts === null) return [];
		const rows = [];
		for (const [name, command] of Object.entries(scripts)) if (typeof command === "string") rows.push({
			name,
			command: `npm run ${name}`
		});
		return rows;
	} catch {
		return [];
	}
}
/** Basename of a posix-style relative path ('' → root marker). */
function baseName(rel) {
	return rel.split("/").at(-1) ?? rel;
}
/**
* Scan the workspace for package.json scripts.
* @param root - absolute workspace root.
* @param options - deps seam + caps.
* @returns suggestions: root package first, then by path depth/name.
*/
async function scanPackageScripts(root, options = {}) {
	const deps = options.deps ?? {
		readdir,
		readFile
	};
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxPackages = options.maxPackages ?? DEFAULT_MAX_PACKAGES;
	/** Relative posix dirs (root = '') found to contain a package.json. */
	const found = [];
	const walk = async (absolute, rel, depth) => {
		if (found.length >= maxPackages) return;
		let entries;
		try {
			entries = await deps.readdir(absolute, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) found.push(rel);
		if (depth >= maxDepth) return;
		for (const entry of entries) {
			if (found.length >= maxPackages) return;
			if (!entry.isDirectory()) continue;
			if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			await walk(join(absolute, entry.name), childRel, depth + 1);
		}
	};
	await walk(root, "", 0);
	found.sort((a, b) => {
		if (a === "") return -1;
		if (b === "") return 1;
		const depthDiff = a.split("/").length - b.split("/").length;
		if (depthDiff !== 0) return depthDiff;
		return a < b ? -1 : a > b ? 1 : 0;
	});
	const out = [];
	for (const rel of found) {
		if (out.length >= maxPackages * 8) break;
		let raw;
		try {
			raw = await deps.readFile(join(root, rel, "package.json"), "utf8");
		} catch {
			continue;
		}
		let pkgName;
		try {
			const manifest = JSON.parse(raw);
			if (typeof manifest.name === "string" && manifest.name.length > 0) pkgName = manifest.name;
		} catch {}
		const pkg = pkgName ?? (rel === "" ? "root" : baseName(rel));
		for (const script of scriptsOf(raw)) out.push({
			name: script.name,
			command: script.command,
			cwd: rel,
			pkg
		});
	}
	return out;
}
//#endregion
export { scanPackageScripts };

//# sourceMappingURL=scanner.js.map