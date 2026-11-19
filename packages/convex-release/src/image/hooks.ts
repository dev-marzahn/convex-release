// The release images' hooks: commands the container's environment names
// (CONVEX_RELEASE_PRE_PUSH, CONVEX_RELEASE_POST_APPLY), run with `sh -c`.
import { spawn } from 'node:child_process';

export type HookName = 'pre-push' | 'post-apply';

/**
 * Runs `command` with the container's environment plus `env`, attached to
 * the container's standard streams. Rejects on a non-zero exit or a signal.
 * Logs nothing itself: the command and `env` can hold secrets.
 */
export function runHook(name: HookName, command: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', (err) => reject(new Error(`${name} hook failed: ${err.message}`)));
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${name} hook failed (${signal ? `signal ${signal}` : `exit ${code}`})`));
    });
  });
}
