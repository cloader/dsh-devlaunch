/**
 * ConfigStore: load/normalize/persist the per-workspace launch configs at
 * ~/.dsh/dsh-devlaunch.json. Atomic write (tmp + rename). Single writer is
 * the host process; readers get frozen snapshots.
 *
 * @module dsh-devlaunch/host/config
 */
import { readFileSync, renameSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  type ConfigFile,
  type WorkspaceConfig,
  normalizeWorkspaceConfig,
  parseConfigFile,
  serializeConfigFile,
} from '../shared/protocol.ts'
import { CONFIG_FILE, dshHomePath } from '../invariant.ts'

/** Options. */
export interface ConfigStoreOptions {
  /** File path (defaults to the DSH home location). */
  readonly file?: string
}

/**
 * The store. All mutations go through replaceWorkspace / clearWorkspace so
 * validation and serialization stay centralized.
 */
export class ConfigStore {
  private readonly file: string
  private data: ConfigFile

  constructor(options: ConfigStoreOptions = {}) {
    this.file = options.file ?? dshHomePath(CONFIG_FILE)
    this.data = this.load()
  }

  /** Read + normalize from disk (tolerant of corruption). */
  private load(): ConfigFile {
    try {
      return parseConfigFile(readFileSync(this.file, 'utf8'))
    } catch {
      return { schemaVersion: 1, workspaces: {} }
    }
  }

  /** Persist atomically. */
  private persist(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, serializeConfigFile(this.data), 'utf8')
    renameSync(tmp, this.file)
  }

  /** Frozen snapshot of one workspace config (empty when unconfigured). */
  get(workspaceId: string): WorkspaceConfig {
    return this.data.workspaces[workspaceId] ?? Object.freeze({ groups: [], profiles: [] })
  }

  /** All configured workspace ids. */
  ids(): string[] {
    return Object.keys(this.data.workspaces)
  }

  /**
   * Validate + install a whole workspace config. Throws on invalid input.
   * @returns the normalized config.
   */
  replaceWorkspace(workspaceId: string, raw: unknown): WorkspaceConfig {
    const normalized = normalizeWorkspaceConfig(raw)
    const workspaces = { ...this.data.workspaces, [workspaceId]: normalized }
    this.data = { schemaVersion: 1, workspaces }
    this.persist()
    return normalized
  }

  /** Forget a workspace's config. */
  clearWorkspace(workspaceId: string): void {
    if (!(workspaceId in this.data.workspaces)) return
    const workspaces = { ...this.data.workspaces }
    delete workspaces[workspaceId]
    this.data = { schemaVersion: 1, workspaces }
    this.persist()
  }
}
