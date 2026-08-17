/**
 * dsh-devlaunch host-side invariants: the plugin name and the config file
 * location. Kept in a separate importable module so tests and the client
 * half can reference them without pulling the host plugin body.
 *
 * @module dsh-devlaunch/invariant
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Cordis plugin name (host half). */
export const PLUGIN_NAME = 'dsh-devlaunch'

/** Config file name under the DSH home. */
export const CONFIG_FILE = 'dsh-devlaunch.json'

/** Per-process output ring buffer ceiling (bytes). */
export const OUTPUT_BUFFER_BYTES = 256 * 1024

/** Max lines kept per process for reconnect catch-up. */
export const OUTPUT_HISTORY_LINES = 2000

/** The config file's parent: the DSH user home (DSH_HOME overrides). */
export function dshHomePath(...segments: string[]): string {
  const override = process.env.DSH_HOME
  const home = resolve(override !== undefined && override.length > 0 ? override : join(homedir(), '.dsh'))
  return join(home, ...segments)
}
