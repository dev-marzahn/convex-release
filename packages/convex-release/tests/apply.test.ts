// The release images' start-up sequence, against a stand-in deployment that
// records each step. The steps themselves are the entrypoint's HTTP calls,
// covered by the end-to-end tests.
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vite-plus/test';

import { applyRelease, modeFromEnv, readSettings, run, type ApplyContext, type Deployment, type Host, type Mode, type Settings } from '../src/image/apply.ts';

interface State {
  pending: number;
  empty: boolean;
  vars: Record<string, string>;
  /** The step that throws, e.g. `migrate`. */
  failAt?: string;
  /** The downgrade check deletes the data, as CONVEX_RELEASE_ON_DOWNGRADE=reset does. */
  reset?: boolean;
}

/** A deployment that appends each step to `steps`. */
function fakeDeployment(state: State, steps: string[]): Deployment {
  let exports = 0;
  const step = async (name: string) => {
    steps.push(name);
    if (state.failAt === name) throw new Error(`${name} failed`);
  };
  return {
    waitUntilUp: () => step('wait'),
    checkDowngrade: async (after) => {
      await step(`downgrade check (${after})`);
      return after === 'start' && Boolean(state.reset);
    },
    predeployChecks: () => step('predeploy checks'),
    pendingMigrations: async () => state.pending,
    isEmpty: async () => state.empty,
    getVariable: async (name) => state.vars[name],
    setVariables: async (changes) => {
      steps.push(`set ${JSON.stringify(changes)}`);
      for (const [name, value] of Object.entries(changes)) {
        if (value === null) delete state.vars[name];
        else state.vars[name] = value;
      }
    },
    exportZip: async () => {
      await step('export');
      return { body: [Buffer.from(`export ${++exports}`)] };
    },
    push: (kind, label) => step(`push ${kind} (${label})`),
    importSnapshot: async () => {
      await step('import snapshot');
      state.empty = false;
    },
    migrate: async () => {
      await step('migrate');
      state.pending = 0;
    },
    seed: () => step('seed'),
  };
}

const NO_SETTINGS: Settings = { seed: false, hooks: {} };

function context(state: State, settings: Partial<Settings> = {}, release: ApplyContext['release'] = { version: '2.0.0', relaxed: true }) {
  const steps: string[] = [];
  const lines: string[] = [];
  const ctx: ApplyContext = {
    url: 'http://127.0.0.1:3210',
    key: 'admin|secret-key',
    settings: { ...NO_SETTINGS, ...settings },
    release,
    deployment: fakeDeployment(state, steps),
    runHook: async (name, _command, env) => {
      steps.push(`${name} hook ${JSON.stringify(env)}`);
      if (state.failAt === `${name} hook`) throw new Error(`${name} hook failed (exit 3)`);
    },
    log: (line) => lines.push(line),
    now: () => new Date('2026-11-18T09:05:03Z'),
  };
  return { ctx, steps, lines };
}

const HOOK_ENV = JSON.stringify({ CONVEX_URL: 'http://127.0.0.1:3210', CONVEX_ADMIN_KEY: 'admin|secret-key' });

test('runs every step in order: checks, pre-push hook, the two pushes around the migrations, record, seeds, post-apply hook', async () => {
  const { ctx, steps } = context(
    { pending: 2, empty: false, vars: { CONVEX_RELEASE_VERSION: '1.0.0' } },
    { seed: true, hooks: { 'pre-push': 'node hooks.mjs pre-push', 'post-apply': 'node hooks.mjs post-apply' } },
  );
  await applyRelease(ctx);
  expect(steps).toEqual([
    'wait',
    'downgrade check (start)',
    'predeploy checks',
    `pre-push hook ${HOOK_ENV}`,
    'push relaxed (pass 1 (validation off))',
    'migrate',
    'push strict (pass 2 (validation on))',
    'set {"CONVEX_RELEASE_VERSION":"2.0.0"}',
    'seed',
    `post-apply hook ${HOOK_ENV}`,
  ]);
});

test("the log names each hook, but never its command, the deployment's URL or the admin key", async () => {
  const { ctx, lines } = context({ pending: 0, empty: false, vars: {} }, { hooks: { 'pre-push': 'node hooks.mjs --token=abc', 'post-apply': 'post' } });
  await applyRelease(ctx);
  expect(lines).toEqual(['pre-push hook: running', 'pre-push hook: done', 'post-apply hook: running', 'post-apply hook: done']);
});

test('a release without migrations pushes once; unset hooks and an unchanged version are skipped', async () => {
  const { ctx, steps } = context({ pending: 0, empty: false, vars: { CONVEX_RELEASE_VERSION: '2.0.0' } }, {}, { version: '2.0.0', relaxed: false });
  await applyRelease(ctx);
  expect(steps).toEqual(['wait', 'downgrade check (start)', 'predeploy checks', 'push strict (push)']);
});

test('a release without a version removes the version an earlier release recorded', async () => {
  const { ctx, steps } = context({ pending: 0, empty: false, vars: { CONVEX_RELEASE_VERSION: '1.0.0' } }, {}, { relaxed: false });
  await applyRelease(ctx);
  expect(steps.at(-1)).toBe('set {"CONVEX_RELEASE_VERSION":null}');
});

describe('fails fast', () => {
  const hooks = { 'pre-push': 'pre', 'post-apply': 'post' };
  test.each([
    ['predeploy checks', ['wait', 'downgrade check (start)', 'predeploy checks']],
    ['pre-push hook', ['wait', 'downgrade check (start)', 'predeploy checks', `pre-push hook ${HOOK_ENV}`]],
    ['migrate', ['wait', 'downgrade check (start)', 'predeploy checks', `pre-push hook ${HOOK_ENV}`, 'push relaxed (pass 1 (validation off))', 'migrate']],
  ])('a failing %s stops the release there, recording nothing', async (failAt, expected) => {
    const { ctx, steps } = context({ pending: 1, empty: false, vars: {}, failAt }, { seed: true, hooks });
    await expect(applyRelease(ctx)).rejects.toThrow('failed');
    expect(steps).toEqual(expected);
  });

  test('a failing post-apply hook fails the release after the data is applied', async () => {
    const { ctx, steps } = context({ pending: 1, empty: false, vars: {}, failAt: 'post-apply hook' }, { hooks });
    await expect(applyRelease(ctx)).rejects.toThrow('post-apply hook failed (exit 3)');
    expect(steps.slice(-2)).toEqual(['set {"CONVEX_RELEASE_VERSION":"2.0.0"}', `post-apply hook ${HOOK_ENV}`]);
  });
});

describe('readSettings', () => {
  test('reads the hooks, the backup folder with 3 kept by default, and the preview settings', () => {
    expect(
      readSettings({
        CONVEX_RELEASE_PRE_PUSH: 'node /app/hooks.mjs pre-push',
        CONVEX_RELEASE_POST_APPLY: 'node /app/hooks.mjs post-apply',
        CONVEX_RELEASE_BACKUP_DIR: '/backups',
        CONVEX_RELEASE_SNAPSHOT: '/backups/a.zip',
        CONVEX_RELEASE_SEED: 'true',
      }),
    ).toEqual({
      hooks: { 'pre-push': 'node /app/hooks.mjs pre-push', 'post-apply': 'node /app/hooks.mjs post-apply' },
      backup: { dir: '/backups', keep: 3 },
      snapshot: '/backups/a.zip',
      seed: true,
    });
  });

  test('empty values count as unset', () => {
    expect(readSettings({ CONVEX_RELEASE_PRE_PUSH: '', CONVEX_RELEASE_BACKUP_DIR: '', CONVEX_RELEASE_SNAPSHOT: '' })).toEqual({ hooks: {}, seed: false });
  });

  test.each(['0', '-1', '2.5', 'three'])('refuses CONVEX_RELEASE_BACKUP_KEEP=%s', (keep) => {
    expect(() => readSettings({ CONVEX_RELEASE_BACKUP_DIR: '/backups', CONVEX_RELEASE_BACKUP_KEEP: keep })).toThrow(
      `CONVEX_RELEASE_BACKUP_KEEP is ${keep}; it has to be a whole number of 1 or more`,
    );
  });

  test('takes CONVEX_RELEASE_BACKUP_KEEP', () => {
    expect(readSettings({ CONVEX_RELEASE_BACKUP_DIR: '/backups', CONVEX_RELEASE_BACKUP_KEEP: '10' }).backup).toEqual({ dir: '/backups', keep: 10 });
  });
});

describe('modes', () => {
  test('CONVEX_URL picks one-shot mode; without it, the combined image deploys to its own backend', () => {
    expect(modeFromEnv({ CONVEX_URL: 'http://backend:3210/' }, false)).toEqual({ kind: 'oneshot', url: 'http://backend:3210' });
    expect(modeFromEnv({}, true)).toEqual({ kind: 'combined', url: 'http://127.0.0.1:3210' });
    expect(modeFromEnv({ PORT: '4000' }, true)).toEqual({ kind: 'combined', url: 'http://127.0.0.1:4000' });
    expect(() => modeFromEnv({}, false)).toThrow('set CONVEX_URL to the backend this image deploys to.');
  });

  function host(mode: Mode, state: State) {
    const events: string[] = [];
    const lines: string[] = [];
    const h: Host = {
      release: { version: '2.0.0', relaxed: false },
      readCredentials: () => events.push('read credentials'),
      startBackend: () => events.push('start backend'),
      removeReady: () => events.push('remove ready file'),
      writeReady: () => events.push('write ready file'),
      adminKey: (m) => {
        events.push(`admin key for ${m.kind}`);
        return 'admin|secret-key';
      },
      deployment: (url) => {
        events.push(`deployment at ${url}`);
        return fakeDeployment(state, events);
      },
      runHook: async (name, _command, env) => {
        events.push(`${name} hook at ${env.CONVEX_URL}`);
        if (state.failAt === `${name} hook`) throw new Error(`${name} hook failed (exit 1)`);
      },
      log: (line) => lines.push(line),
      now: () => new Date(),
    };
    return { run: () => run(mode, { seed: false, hooks: { 'post-apply': 'post' } }, h), events, lines };
  }

  test('combined: removes the ready file before the backend starts, and writes it only after the post-apply hook', async () => {
    const { run, events, lines } = host({ kind: 'combined', url: 'http://127.0.0.1:3210' }, { pending: 0, empty: false, vars: {} });
    await run();
    expect(events.slice(0, 5)).toEqual([
      'remove ready file',
      'read credentials',
      'start backend',
      'admin key for combined',
      'deployment at http://127.0.0.1:3210',
    ]);
    expect(events.slice(-2)).toEqual(['post-apply hook at http://127.0.0.1:3210', 'write ready file']);
    expect(lines.at(-1)).toBe('ready');
  });

  test('combined: reads the credentials once, before the backend starts and the admin key is derived', async () => {
    // Both would otherwise create the instance secret on a first start, and
    // the admin key would not match the backend's.
    const { run, events } = host({ kind: 'combined', url: 'http://127.0.0.1:3210' }, { pending: 0, empty: false, vars: {} });
    await run();
    expect(events.filter((e) => e === 'read credentials')).toHaveLength(1);
    expect(events.indexOf('read credentials')).toBeLessThan(events.indexOf('start backend'));
    expect(events.indexOf('read credentials')).toBeLessThan(events.indexOf('admin key for combined'));
  });

  test('combined: a failed hook leaves the ready file absent', async () => {
    const { run, events } = host({ kind: 'combined', url: 'http://127.0.0.1:3210' }, { pending: 0, empty: false, vars: {}, failAt: 'post-apply hook' });
    await expect(run()).rejects.toThrow('post-apply hook failed (exit 1)');
    expect(events).not.toContain('write ready file');
  });

  test('one-shot: runs the same steps and hooks against CONVEX_URL, with no backend or ready file of its own', async () => {
    const { run, events, lines } = host({ kind: 'oneshot', url: 'http://backend:3210' }, { pending: 0, empty: false, vars: {} });
    await run();
    expect(events).toEqual([
      'admin key for oneshot',
      'deployment at http://backend:3210',
      'wait',
      'downgrade check (start)',
      'predeploy checks',
      'push strict (push)',
      'set {"CONVEX_RELEASE_VERSION":"2.0.0"}',
      'post-apply hook at http://backend:3210',
    ]);
    expect(lines).toEqual(['deploying to http://backend:3210', 'post-apply hook: running', 'post-apply hook: done', 'deployed']);
  });
});

describe('backup before migrate', () => {
  const backupDir = () => mkdtempSync(join(tmpdir(), 'convex-release-apply-backup-'));

  test('with migrations pending on data, exports before the pre-push hook and records the file on the deployment', async () => {
    const dir = backupDir();
    const state: State = { pending: 1, empty: false, vars: { CONVEX_RELEASE_VERSION: '1.0.0' } };
    const { ctx, steps } = context(state, { backup: { dir, keep: 3 }, hooks: { 'pre-push': 'pre' } });
    await applyRelease(ctx);
    expect(steps.slice(3, 6)).toEqual(['export', 'set {"CONVEX_RELEASE_BACKUP":"20261118-090503-1.0.0-to-2.0.0.zip"}', `pre-push hook ${HOOK_ENV}`]);
    expect(readFileSync(join(dir, '20261118-090503-1.0.0-to-2.0.0.zip'), 'utf8')).toBe('export 1');
    // Applied: the next upgrade takes a backup of its own.
    expect(steps).toContain('set {"CONVEX_RELEASE_VERSION":"2.0.0","CONVEX_RELEASE_BACKUP":null}');
    expect(state.vars).toEqual({ CONVEX_RELEASE_VERSION: '2.0.0' });
  });

  test.each([
    ['no migration is pending', { pending: 0, empty: false }],
    ['the deployment has no data', { pending: 3, empty: true }],
  ])('takes none when %s', async (_, s) => {
    const dir = backupDir();
    const { ctx, steps } = context({ ...s, vars: {} }, { backup: { dir, keep: 3 } });
    await applyRelease(ctx);
    expect(steps).not.toContain('export');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('a failed backup stops the release before the pre-push hook and the first push', async () => {
    const { ctx, steps } = context(
      { pending: 1, empty: false, vars: {}, failAt: 'export' },
      { backup: { dir: backupDir(), keep: 3 }, hooks: { 'pre-push': 'pre' } },
    );
    await expect(applyRelease(ctx)).rejects.toThrow('backup failed: export failed');
    expect(steps.at(-1)).toBe('export');
  });

  test('a crash loop and a fix release reuse the first backup; only the next successful upgrade takes another', async () => {
    const dir = backupDir();
    // Three earlier upgrades' backups, with CONVEX_RELEASE_BACKUP_KEEP=3.
    for (const name of ['20260101-000000-0.1.0-to-0.2.0.zip', '20260201-000000-0.2.0-to-0.3.0.zip', '20260301-000000-0.3.0-to-1.0.0.zip']) {
      writeFileSync(join(dir, name), 'older');
    }
    const settings = { backup: { dir, keep: 3 } };
    const state: State = { pending: 2, empty: false, vars: { CONVEX_RELEASE_VERSION: '1.0.0' }, failAt: 'migrate' };
    const clean = '20261118-090503-1.0.0-to-2.0.0.zip';

    // 1.0.0 -> 2.0.0 fails in a migration, and the container restarts three times.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { ctx } = context(state, settings, { version: '2.0.0', relaxed: true });
      await expect(applyRelease(ctx)).rejects.toThrow('migrate failed');
    }
    // A fix release, 2.0.1, still fails: the data is still 1.0.0's, half migrated.
    const fix = context(state, settings, { version: '2.0.1', relaxed: true });
    fix.ctx.now = () => new Date('2026-11-19T10:00:00Z');
    await expect(applyRelease(fix.ctx)).rejects.toThrow('migrate failed');
    expect(fix.lines).toContain(`backup: reusing ${clean}, taken before an earlier attempt at this upgrade`);
    expect(readdirSync(dir).sort()).toEqual(['20260201-000000-0.2.0-to-0.3.0.zip', '20260301-000000-0.3.0-to-1.0.0.zip', clean]);
    expect(readFileSync(join(dir, clean), 'utf8')).toBe('export 1');

    // 2.0.1 succeeds once the cause is fixed.
    delete state.failAt;
    const fixed = context(state, settings, { version: '2.0.1', relaxed: true });
    await applyRelease(fixed.ctx);
    expect(fixed.steps).not.toContain('export');
    expect(state.vars).toEqual({ CONVEX_RELEASE_VERSION: '2.0.1' });

    // The next upgrade backs up the data as 2.0.1 left it.
    state.pending = 1;
    const next = context(state, settings, { version: '3.0.0', relaxed: true });
    next.ctx.now = () => new Date('2026-12-01T00:00:00Z');
    await applyRelease(next.ctx);
    expect(readdirSync(dir).sort()).toEqual(['20260301-000000-0.3.0-to-1.0.0.zip', clean, '20261201-000000-2.0.1-to-3.0.0.zip']);
  });

  test.each([
    ['a snapshot import', { pending: 1, empty: true }, { snapshot: '/backups/x.zip' }, 'import snapshot'],
    ['a reset (CONVEX_RELEASE_ON_DOWNGRADE=reset)', { pending: 1, empty: true, reset: true }, {}, 'downgrade check (start)'],
  ])('%s forgets the recorded backup and version, which described the data it replaced', async (_, s, settings, after) => {
    const state: State = { ...s, vars: { CONVEX_RELEASE_VERSION: '9.0.0', CONVEX_RELEASE_BACKUP: '20261101-000000-8.0.0-to-9.0.0.zip' }, failAt: 'migrate' };
    const { ctx, steps } = context(state, { ...settings, backup: { dir: backupDir(), keep: 3 } });
    await expect(applyRelease(ctx)).rejects.toThrow('migrate failed');
    const forgotten = steps.indexOf('set {"CONVEX_RELEASE_VERSION":null,"CONVEX_RELEASE_BACKUP":null}');
    expect(forgotten).toBeGreaterThan(steps.indexOf(after));
    expect(forgotten).toBeLessThan(steps.indexOf('migrate'));
    expect(state.vars).toEqual({});
  });
});
