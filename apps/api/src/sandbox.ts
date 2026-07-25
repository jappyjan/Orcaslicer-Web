/**
 * Disposable per-job sandboxes. HARD CONSTRAINT #4 — the one that takes the host down
 * if it is wrong.
 *
 * A single job leaves 200–500 MB of intermediates. Every slice therefore runs in
 * `/work/{jobId}/` and that directory is `rm -rf`ed in a `finally` that runs on
 * success, failure, timeout AND cancellation alike.
 *
 * The API is a scope function rather than create/remove pair so there is no way to
 * write the acquire without the release: `withSandbox()` owns the `finally`, and
 * callers only see the path.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export interface Sandbox {
  jobId: string;
  /** Absolute path to the sandbox root. Everything a job writes goes under here. */
  path: string;
}

export interface SandboxOptions {
  /** Called if removal fails; the caller decides whether that is worth alerting on. */
  onCleanupError?: (error: unknown, sandbox: Sandbox) => void;
  /** Escape hatch for debugging a failing slice. Never enabled in production. */
  keep?: boolean;
}

/** Job ids are generated server-side, but the path is built from one, so verify anyway. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function sandboxPath(workRoot: string, jobId: string): string {
  if (!SAFE_ID.test(jobId)) throw new Error(`unsafe job id: ${JSON.stringify(jobId)}`);
  if (!isAbsolute(workRoot)) throw new Error(`work root must be absolute: ${workRoot}`);
  const path = resolve(join(workRoot, jobId));
  if (path === resolve(workRoot) || !path.startsWith(`${resolve(workRoot)}/`)) {
    throw new Error(`sandbox path escaped the work root: ${path}`);
  }
  return path;
}

export async function withSandbox<T>(
  workRoot: string,
  jobId: string,
  options: SandboxOptions,
  body: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const path = sandboxPath(workRoot, jobId);
  const sandbox: Sandbox = { jobId, path };
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    return await body(sandbox);
  } finally {
    if (options.keep !== true) {
      try {
        await rm(path, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        // Never let a cleanup failure mask the job's own outcome — but never let it pass
        // unnoticed either: unswept sandboxes are what fills the disk.
        options.onCleanupError?.(error, sandbox);
      }
    }
  }
}

/**
 * Remove anything left in the work root. Called at boot: a crash or a `docker kill`
 * bypasses the `finally` above, and the next start is the only chance to notice.
 */
export async function purgeWorkRoot(workRoot: string): Promise<void> {
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  // Empty the directory rather than removing it: in the shipped stack `/work` is a
  // mount point (a tmpfs in dev, a volume in production), and `rmdir` on it fails with
  // EBUSY.
  for (const entry of await readdir(workRoot)) {
    await rm(join(workRoot, entry), { recursive: true, force: true, maxRetries: 3 });
  }
}
