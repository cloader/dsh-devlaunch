import { join, resolve } from "node:path";
import { homedir } from "node:os";
//#region src/invariant.ts
/**
* dsh-devlaunch host-side invariants: the plugin name and the config file
* location. Kept in a separate importable module so tests and the client
* half can reference them without pulling the host plugin body.
*
* @module dsh-devlaunch/invariant
*/
/** Config file name under the DSH home. */
const CONFIG_FILE = "dsh-devlaunch.json";
/** The config file's parent: the DSH user home (DSH_HOME overrides). */
function dshHomePath(...segments) {
	const override = process.env.DSH_HOME;
	return join(resolve(override !== void 0 && override.length > 0 ? override : join(homedir(), ".dsh")), ...segments);
}
//#endregion
export { CONFIG_FILE, dshHomePath };

//# sourceMappingURL=invariant.js.map