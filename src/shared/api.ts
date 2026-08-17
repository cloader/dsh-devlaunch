/**
 * Wire contract shared by both halves: route paths and the JSON envelope.
 *
 * @module dsh-devlaunch/shared/api
 */

/** JSON route prefix on the shared DSH webserver. */
export const ROUTE_PREFIX = '/dsh-devlaunch'

/** SSE stream path (workspace-scoped via query param). */
export const STREAM_PATH = '/dsh-devlaunch/stream'

/** Success envelope. */
export interface ApiOk<T> {
  readonly ok: true
  readonly value: T
}

/** Failure envelope. */
export interface ApiFail {
  readonly ok: false
  readonly error: {
    readonly code: 'invalid_input' | 'not_found' | 'internal'
    readonly message: string
  }
}

/** Either envelope. */
export type ApiResult<T> = ApiOk<T> | ApiFail

/** Workspace-facing row the host advertises for workspace pickers. */
export interface WorkspaceRow {
  readonly id: string
  readonly title: string
  readonly path: string
}
