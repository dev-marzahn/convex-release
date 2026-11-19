// The release images' hooks, run for real with `sh -c`.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vite-plus/test';

import { runHook } from '../src/image/hooks.ts';

afterEach(() => vi.unstubAllEnvs());

const out = () => join(mkdtempSync(join(tmpdir(), 'convex-release-hook-')), 'out');

test("a hook gets the deployment's URL and admin key on top of the container's environment", async () => {
  vi.stubEnv('FROM_CONTAINER', 'kept');
  const file = out();
  await runHook('pre-push', `printf '%s|%s|%s' "$CONVEX_URL" "$CONVEX_ADMIN_KEY" "$FROM_CONTAINER" > ${file}`, {
    CONVEX_URL: 'http://127.0.0.1:3210',
    CONVEX_ADMIN_KEY: 'admin|key',
  });
  expect(readFileSync(file, 'utf8')).toBe('http://127.0.0.1:3210|admin|key|kept');
});

test('a non-zero exit fails with the hook name and the exit code', async () => {
  await expect(runHook('post-apply', 'echo half done; exit 3', {})).rejects.toThrow(/^post-apply hook failed \(exit 3\)$/);
});

test('a hook killed by a signal fails, naming the signal', async () => {
  await expect(runHook('pre-push', 'kill -TERM $$', {})).rejects.toThrow(/^pre-push hook failed \(signal SIGTERM\)$/);
});
