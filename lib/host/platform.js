import { spawn } from "node:child_process";
//#region src/host/platform.ts
/**
* Platform helpers: Windows process-tree termination. On Windows a spawned
* `npm dev` is a shell → cmd.exe → node chain; killing only the top pid
* orphans the actual server. `taskkill /T /F` walks and kills the whole
* tree. Non-Windows falls back to the process-group kill.
*
* Extracted into a module so tests can stub it.
*
* @module dsh-devlaunch/host/platform
*/
/** Are we on Windows? */
function isWindows() {
	return process.platform === "win32";
}
/** Real implementation over node:child_process. */
const realKillFace = {
	taskkill(pid) {
		spawn("taskkill", [
			"/PID",
			String(pid),
			"/T",
			"/F"
		], {
			stdio: "ignore",
			windowsHide: true
		}).on("error", () => {});
	},
	groupKill(child) {
		try {
			if (typeof child.pid === "number") process.kill(-child.pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {}
		}
	}
};
/** Active kill face (mutable seam). */
let killFace = realKillFace;
/** Kill a process tree by hook or crook, platform-appropriate. */
function killTree(child, pid, windows) {
	if (windows && pid !== void 0) {
		killFace.taskkill(pid);
		return;
	}
	killFace.groupKill(child);
}
//#endregion
export { isWindows, killFace, killTree, realKillFace };

//# sourceMappingURL=platform.js.map