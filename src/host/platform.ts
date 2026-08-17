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
import { type ChildProcess, execFile, spawn } from 'node:child_process'

/** Are we on Windows? */
export function isWindows(): boolean {
  return process.platform === 'win32'
}

/** The taskkill face (seam for tests). */
export interface KillFace {
  taskkill(pid: number): void
  groupKill(child: ChildProcess): void
}

/** Real implementation over node:child_process. */
export const realKillFace: KillFace = {
  taskkill(pid) {
    // /T = tree, /F = force. Fire-and-forget; errors surface as the close
    // event on the child we already watch.
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('error', () => { /* taskkill missing → group kill fallback below */ })
  },
  groupKill(child) {
    try {
      // Negative pid = the whole detached group (POSIX).
      if (typeof (child as { pid?: number }).pid === 'number') {
        process.kill(-child.pid!, 'SIGTERM')
      }
    } catch {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
    }
  },
}

/** Active kill face (mutable seam). */
export let killFace: KillFace = realKillFace

/** Replace the kill face (tests). */
export function setKillFace(face: KillFace): void {
  killFace = face
}

/** Kill a process tree by hook or crook, platform-appropriate. */
export function killTree(child: ChildProcess, pid: number | undefined, windows: boolean): void {
  if (windows && pid !== undefined) {
    killFace.taskkill(pid)
    return
  }
  killFace.groupKill(child)
}

/** execFile promisified with timeout — used by routes for package.json scan. */
export function execFileText(file: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr.length > 0 ? stderr.toString() : error.message))
        return
      }
      resolvePromise(stdout.toString())
    })
  })
}
