// End-to-end tests of the release images: fixture apps v1-v5 are built from
// the images exactly as a user's app would be, then upgraded on real data.
// v4 and v5 depend on e2e/libs/predeploy-fixture, whose predeploy check
// refuses a release while a flag document exists in its component.
//
//   bun run e2e            all scenarios
//   bun run e2e steps oneshot   only these
//
// Needs Docker. Builds the package first (`vp run -r build`).
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = '4361726e697461732c206c69746572616c6c79206d65616e696e6720226c6974';
const PREFIX = 'convex-release-e2e';
const PORT = 37300;
const URL = `http://127.0.0.1:${PORT}`;
/** The backend the images pin, for the stock backend in the one-shot scenario. */
const BACKEND_IMAGE = /^ARG BACKEND_IMAGE=(\S+)$/m.exec(readFileSync(join(ROOT, 'images/Dockerfile'), 'utf8'))![1]!;

function sh(cmd: string, args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${String(result.stderr ?? '').slice(-3000)}`);
  return String(result.stdout ?? '');
}
const docker = (...args: string[]) => sh('docker', args);
const log = (message: string) => console.log(message);

// ---------------------------------------------------------------- images ---

function buildImages() {
  log('building the package and base images');
  sh('bun', ['run', 'build'], { cwd: ROOT });
  for (const target of ['combined', 'oneshot']) {
    docker('build', '-q', '-f', 'images/Dockerfile', '--target', target, '-t', `${PREFIX}:${target}`, ROOT);
  }
}

/** Package managers the image build supports besides Bun, with the command that writes their lockfile. */
const PACKAGE_MANAGERS = {
  npm: { lock: 'npm install --package-lock-only --no-audit --no-fund' },
  // pnpm refuses dependency build scripts nobody approved, as it would on the user's machine.
  pnpm: { packageManager: 'pnpm@12.18.0', lock: 'corepack pnpm install --lockfile-only', files: { 'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n' } },
  // Yarn doesn't install peer dependencies; `init` adds convex-helpers for it.
  yarn1: { packageManager: 'yarn@1.22.22', lock: 'corepack yarn install --ignore-scripts', peers: { 'convex-helpers': '^0.1.115' } },
  yarn4: {
    packageManager: 'yarn@4.18.1',
    lock: 'corepack yarn install --mode=update-lockfile',
    files: { '.yarnrc.yml': 'nodeLinker: node-modules\n' },
    peers: { 'convex-helpers': '^0.1.115' },
  },
} as const;
type PackageManager = keyof typeof PACKAGE_MANAGERS;

/**
 * A standalone build context for a fixture app, as a user's repo would look.
 * With `pm`, the context gets that package manager's lockfile, and the image
 * is tagged `<version>-<pm>`.
 */
function buildApp(version: string, base: 'combined' | 'oneshot', tarballs: Tarballs, pm?: PackageManager) {
  const context = mkdtempSync(join(tmpdir(), `${PREFIX}-${version}-`));
  try {
    cpSync(join(ROOT, 'e2e/apps', version), context, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const catalog = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { catalog: Record<string, string> }).catalog;
    const manifest = JSON.parse(readFileSync(join(context, 'package.json'), 'utf8')) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = (manifest[field] ?? {}) as Record<string, string>;
      for (const [name, range] of Object.entries(deps)) {
        if (range === 'workspace:*') {
          // Each workspace package goes in as its own tarball, as an npm install would bring it.
          const tarball = tarballs[name];
          if (!tarball) throw new Error(`${version} depends on workspace package ${name}, which the e2e doesn't pack`);
          const file = `${name.replace(/^@[^/]+\//, '')}.tgz`;
          cpSync(tarball, join(context, file));
          deps[name] = `file:./${file}`;
        } else if (range === 'catalog:') {
          deps[name] = catalog[name]!;
        }
      }
    }
    const setup = pm ? PACKAGE_MANAGERS[pm] : undefined;
    if (setup && 'packageManager' in setup) manifest.packageManager = setup.packageManager;
    if (setup && 'peers' in setup) Object.assign(manifest.dependencies as Record<string, string>, setup.peers);
    writeFileSync(join(context, 'package.json'), JSON.stringify(manifest, null, 2));
    if (setup && 'files' in setup) for (const [file, content] of Object.entries(setup.files)) writeFileSync(join(context, file), content);
    if (setup) {
      // The lockfile, written by that package manager in a throwaway container. The container runs as root, so on
      // Linux it hands what it wrote back to this user, or the cleanup below fails with EACCES.
      const owner = process.getuid ? `${process.getuid()}:${process.getgid!()}` : '';
      const lock = owner ? `${setup.lock} && chown -R ${owner} /app` : setup.lock;
      docker('run', '--rm', '-v', `${context}:/app`, '-w', '/app', '-e', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0', 'node:24-trixie-slim', 'sh', '-c', lock);
      rmSync(join(context, 'node_modules'), { recursive: true, force: true });
    }
    writeFileSync(join(context, 'Dockerfile'), `FROM ${PREFIX}:${base}\n`);
    writeFileSync(join(context, '.dockerignore'), 'node_modules\n');
    const tag = `${PREFIX}-app:${version}${base === 'oneshot' ? '-oneshot' : ''}${pm ? `-${pm}` : ''}`;
    // --progress=plain puts the build step's output in the error, if it fails.
    docker('build', ...(pm ? ['--progress=plain'] : ['-q']), '-t', tag, context);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/** Workspace packages the fixture apps depend on, by name: the path of each one's packed tarball. */
type Tarballs = Record<string, string>;

/** Packs the workspace package in `dir` (relative to the repo root) into its own temporary folder. */
function packTarball(dir: string): string {
  const out = mkdtempSync(join(tmpdir(), `${PREFIX}-pack-`));
  sh('bun', ['pm', 'pack', '--destination', out, '--quiet'], { cwd: join(ROOT, dir) });
  const file = sh('ls', [out]).trim().split('\n')[0]!;
  return join(out, file);
}

// ------------------------------------------------------------- containers ---

const container = (name: string) => `${PREFIX}-${name}`;

function removeAll() {
  const ids = docker('ps', '-aq', '--filter', `name=${PREFIX}-`).trim();
  if (ids) docker('rm', '-f', ...ids.split('\n'));
  const volumes = docker('volume', 'ls', '-q', '--filter', `name=${PREFIX}-`).trim();
  if (volumes) docker('volume', 'rm', ...volumes.split('\n'));
  spawnSync('docker', ['network', 'rm', `${PREFIX}-net`], { stdio: 'ignore' });
}

interface Run {
  healthy: boolean;
  exitCode: number;
  /** convex-release's lines and those of e2e/hooks.mjs. */
  log: string[];
  /** Everything the container printed. */
  all: string;
}

const OUR_LINES = /^\[(convex-release|hook)\]/;

/**
 * Starts a combined app image on `volume` and waits until it's healthy or has
 * exited. `extra` goes to `docker run`, e.g. `-e CONVEX_RELEASE_SEED=true`.
 */
async function runCombined(version: string, volume: string, extra: string[] = []): Promise<Run> {
  const name = container('app');
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `${PORT}:3210`,
    '-e',
    'INSTANCE_NAME=e2e',
    '-e',
    `INSTANCE_SECRET=${SECRET}`,
    '-v',
    `${PREFIX}-${volume}:/convex/data`,
    ...extra,
    `${PREFIX}-app:${version}`,
  );
  for (;;) {
    const state = docker('inspect', '-f', '{{.State.Health.Status}} {{.State.Running}} {{.State.ExitCode}}', name).trim().split(' ');
    if (state[0] === 'healthy' || state[1] !== 'true') {
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
      const lines = `${logs.stdout}\n${logs.stderr}`.split('\n');
      return { healthy: state[0] === 'healthy', exitCode: Number(state[2]), log: lines.filter((l) => OUR_LINES.test(l)), all: lines.join('\n') };
    }
    await sleep(1000);
  }
}

function adminKey(name = container('app')): string {
  return docker('exec', name, './generate_admin_key.sh').trim().split('\n').at(-1)!;
}

async function call<T>(path: string, args: object, key = adminKey(), url = URL, componentPath?: string): Promise<T> {
  const res = await fetch(`${url}/api/function`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
    body: JSON.stringify({ path, format: 'json', args, ...(componentPath ? { componentPath } : {}) }),
  });
  const r = (await res.json()) as { status: string; value: T; errorMessage?: string };
  if (r.status !== 'success') throw new Error(`${path}: ${r.errorMessage}`);
  return r.value;
}

/** A stock backend, without any app, for the one-shot images to deploy to. Returns its admin key. */
async function startBackend(): Promise<string> {
  docker('network', 'create', `${PREFIX}-net`);
  docker(
    'run',
    '-d',
    '--name',
    container('backend'),
    '--network',
    `${PREFIX}-net`,
    '-p',
    `${PORT}:3210`,
    '-e',
    'INSTANCE_NAME=e2e',
    '-e',
    `INSTANCE_SECRET=${SECRET}`,
    '-v',
    `${PREFIX}-data:/convex/data`,
    BACKEND_IMAGE,
  );
  while (
    !(await fetch(`${URL}/version`).then(
      (r) => r.ok,
      () => false,
    ))
  )
    await sleep(500);
  return adminKey(container('backend'));
}

/** Applies a one-shot app image to the backend `startBackend` started. `extra` goes to `docker run`. */
function applyOneshot(version: string, extra: string[] = []) {
  return spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      `${PREFIX}-net`,
      '-e',
      `CONVEX_URL=http://${container('backend')}:3210`,
      '-e',
      'INSTANCE_NAME=e2e',
      '-e',
      `INSTANCE_SECRET=${SECRET}`,
      ...extra,
      `${PREFIX}-app:${version}-oneshot`,
    ],
    { encoding: 'utf8' },
  );
}

/** Starts `version`'s image on `volume` with its backend alone, skipping the release, the way an operator fixes a deployment. */
async function bareBackend(version: string, volume = 'data') {
  const name = container('app');
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  docker(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `${PORT}:3210`,
    '-e',
    'INSTANCE_NAME=e2e',
    '-e',
    `INSTANCE_SECRET=${SECRET}`,
    '-v',
    `${PREFIX}-${volume}:/convex/data`,
    '--entrypoint',
    './run_backend.sh',
    `${PREFIX}-app:${version}`,
  );
  while (
    !(await fetch(`${URL}/version`).then(
      (r) => r.ok,
      () => false,
    ))
  )
    await sleep(500);
}

/** A deployment variable, as a hook or the dashboard reads it. */
async function getEnv(name: string, key = adminKey(), url = URL): Promise<string | undefined> {
  const res = await fetch(`${url}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
    body: JSON.stringify({ path: '_system/cli/queryEnvironmentVariables:get', format: 'json', args: { name } }),
  });
  const r = (await res.json()) as { status: string; value: { value: string } | null; errorMessage?: string };
  if (r.status !== 'success') throw new Error(`reading ${name}: ${r.errorMessage}`);
  return r.value?.value;
}

/** Mounts e2e/hooks.mjs and names it as both hooks, or `fail` for one of them. */
function hooks({ prePush = 'pre-push', postApply = 'post-apply' } = {}): string[] {
  return [
    '-v',
    `${join(ROOT, 'e2e/hooks.mjs')}:/hooks.mjs:ro`,
    '-e',
    `CONVEX_RELEASE_PRE_PUSH=node /hooks.mjs ${prePush}`,
    '-e',
    `CONVEX_RELEASE_POST_APPLY=node /hooks.mjs ${postApply}`,
  ];
}

const BACKUPS = `${PREFIX}-backups`;

/** The backup volume at /backups, with CONVEX_RELEASE_BACKUP_DIR pointing there. */
const backups = (keep = 3) => ['-v', `${BACKUPS}:/backups`, '-e', 'CONVEX_RELEASE_BACKUP_DIR=/backups', '-e', `CONVEX_RELEASE_BACKUP_KEEP=${keep}`];

/** Runs `script` in a throwaway container with the backup volume at /backups. */
const inBackups = (script: string) => docker('run', '--rm', '-v', `${BACKUPS}:/backups`, '--entrypoint', 'sh', `${PREFIX}-app:v1`, '-c', script);

/** The backup volume's files, sorted. */
const listBackups = () => inBackups('ls -1 /backups').trim().split('\n').filter(Boolean).sort();

const backupHash = (file: string) => inBackups(`sha256sum /backups/${file}`).split(' ')[0]!;

/** A table's document count, through a system query every deployment has. */
const tableSize = (table: string, key = adminKey()) =>
  fetch(`${URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
    body: JSON.stringify({ path: '_system/cli/tableSize:default', format: 'json', args: { tableName: table } }),
  })
    .then((r) => r.json() as Promise<{ value: number }>)
    .then((r) => r.value);

/** Throws unless each expected text appears in `lines`, in this order, each as part of a line. */
function expectLines(lines: string[], expected: string[], what: string) {
  let at = 0;
  for (const text of expected) {
    const found = lines.findIndex((line, i) => i >= at && line.includes(text));
    expect(found >= 0, `${what}: no line with ${JSON.stringify(text)} after line ${at}:\n${lines.join('\n')}`);
    at = found + 1;
  }
}

/** Which app code is live: v5's `version:get`, or the "Could not find function" error on older ones. */
async function liveVersion(key: string): Promise<string> {
  try {
    return await call<string>('version:get', {}, key);
  } catch (err) {
    if (/Could not find (public )?function/.test(String(err))) return 'older than v5';
    throw err;
  }
}

/** The fixture library's flag: while one exists, its predeploy check refuses every release. */
const block = (key: string) => call('flags:block', { reason: 'e2e' }, key, URL, 'predeployFixture');
const unblock = (key: string) => call('flags:unblock', {}, key, URL, 'predeployFixture');

const REFUSAL = ['A predeploy check refused this release; nothing was pushed.', 'predeploy-fixture: blocked by a flag', '  - e2e', 'Skip a check with'];

async function setEnv(name: string, value: string | null, key = adminKey()) {
  const res = await fetch(`${URL}/api/update_environment_variables`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
    body: JSON.stringify({ changes: [{ name, value }] }),
  });
  if (!res.ok) throw new Error(`set ${name}: HTTP ${res.status}`);
}

/** Writes `count` messages in the shape of `version`. */
async function write(version: string, count: number, key = adminKey(), url = URL) {
  const tag = version.replace(/-.*/, '');
  for (let i = 0; i < count; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, count - i) }, (_, j) =>
        call(
          'messages:send',
          tag === 'v1' ? { body: `${tag} msg ${i + j}`, author: `user${i + j}` } : { text: `${tag} msg ${i + j}`, author: `user${i + j}` },
          key,
          url,
        ),
      ),
    );
  }
}

interface Summary {
  messages: number;
  wellFormed: number;
  authors: number;
  users: number;
}

/** The v4 shape check: every message has text, a matching length and an author document. */
async function check(key = adminKey(), url = URL): Promise<Summary> {
  let cursor: string | null = null;
  const authors = new Set<string>();
  let messages = 0;
  let wellFormed = 0;
  for (;;) {
    const page: { count: number; wellFormed: number; authors: string[]; isDone: boolean; cursor: string } = await call(
      'messages:checkPage',
      { cursor },
      key,
      url,
    );
    messages += page.count;
    wellFormed += page.wellFormed;
    page.authors.forEach((a) => authors.add(a));
    if (page.isDone) break;
    cursor = page.cursor;
  }
  return { messages, wellFormed, authors: authors.size, users: await call<number>('messages:userCount', {}, key, url) };
}

// -------------------------------------------------------------- scenarios ---

class Fail extends Error {}
function expect(condition: boolean, message: string) {
  if (!condition) throw new Fail(message);
}

async function upgradePath(versions: string[], perStop: number) {
  for (const version of versions) {
    const run = await runCombined(version, 'data');
    expect(run.healthy, `${version} didn't become healthy:\n${run.log.join('\n')}`);
    log(`  ${version}: ${run.log.filter((l) => !l.endsWith('ready')).join(' | ')}`);
    await write(version, perStop);
  }
  const summary = await check();
  const total = versions.length * perStop;
  expect(summary.messages === total && summary.wellFormed === total, `expected ${total} well-formed messages, got ${JSON.stringify(summary)}`);
  expect(summary.users === perStop, `expected ${perStop} users, got ${summary.users}`);
  log(`  ${JSON.stringify(summary)}`);
}

const scenarios: Record<string, () => Promise<void>> = {
  steps: () => upgradePath(['v1', 'v2', 'v3', 'v4'], 200),
  jump: () => upgradePath(['v1', 'v4'], 200),
  skip: () => upgradePath(['v2', 'v4'], 200),

  async large() {
    await runCombined('v1', 'data');
    const key = adminKey();
    await Promise.all(Array.from({ length: 20 }, (_, chunk) => call('messages:seed', { chunk, size: 1000, authors: 300 }, key)));
    const started = Date.now();
    const run = await runCombined('v4', 'data');
    expect(run.healthy, `v4 didn't become healthy:\n${run.log.join('\n')}`);
    const summary = await check();
    expect(summary.wellFormed === 20_000 && summary.users === 300, JSON.stringify(summary));
    log(`  20000 documents upgraded v1 -> v4 in ${Math.round((Date.now() - started) / 1000)}s`);
  },

  async failure() {
    await runCombined('v1', 'data');
    await write('v1', 500);
    await setEnv('FAIL_AT', 'user150');
    const failed = await runCombined('v4', 'data');
    expect(!failed.healthy && failed.exitCode === 1, `expected exit 1, got ${failed.exitCode}`);
    log(`  v4 with FAIL_AT: exit ${failed.exitCode} (${failed.log.find((l) => l.includes('failed'))})`);
    // Fix the cause with the backend alone, the way an operator would.
    await bareBackend('v4');
    await setEnv('FAIL_AT', null);
    const resumed = await runCombined('v4', 'data');
    expect(resumed.healthy, `restart didn't resume:\n${resumed.log.join('\n')}`);
    const summary = await check();
    expect(summary.wellFormed === 500, JSON.stringify(summary));
    log(`  restart resumed: ${JSON.stringify(summary)}`);
  },

  async downgrade() {
    await upgradePath(['v1', 'v4'], 100);
    // v3 has some of the migrations; v1 has none, so it never runs any.
    for (const version of ['v3', 'v1']) {
      const older = await runCombined(version, 'data');
      const refusal = older.log.find((l) => l.includes('newer version'));
      expect(!older.healthy && older.exitCode === 1, `${version} on v4 data should refuse, got exit ${older.exitCode}`);
      expect(Boolean(refusal?.includes('nothing was pushed')) && !older.log.some((l) => l.endsWith(': pushed')), `${version} pushed before refusing`);
      log(`  ${version} on v4 data: refused before pushing`);
    }
    const back = await runCombined('v4', 'data');
    expect(back.healthy, 'rolling forward to v4 failed');
    expect((await check()).wellFormed === 200, 'data changed by the refused downgrade');
  },

  /** `test-upgrade --snapshot`: a v3 deployment's export, rehearsed against v4 in throwaway containers. */
  async rehearsal() {
    await runCombined('v1', 'data');
    await call('messages:seed', { chunk: 0, size: 500, authors: 25 });
    const v3 = await runCombined('v3', 'data');
    expect(v3.healthy, 'v3 failed');
    const dir = mkdtempSync(join(tmpdir(), `${PREFIX}-snapshot-`));
    const zip = join(dir, 'prod.zip');
    try {
      sh(join(ROOT, 'e2e/apps/v3/node_modules/.bin/convex'), ['export', '--path', zip], {
        cwd: join(ROOT, 'e2e/apps/v3'),
        env: { ...process.env, CONVEX_SELF_HOSTED_URL: URL, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey(), CONVEX_DEPLOYMENT: '' },
      });
      removeAll();
      const out = sh(
        'node',
        [
          join(ROOT, 'packages/convex-release/dist/cli.mjs'),
          'test-upgrade',
          '--from',
          `${PREFIX}-app:v3`,
          '--to',
          `${PREFIX}-app:v4`,
          '--snapshot',
          zip,
          '--check',
          'messages:userCount',
        ],
        { cwd: join(ROOT, 'e2e/apps/v4'), env: { ...process.env, CI: '1' } },
      );
      // The snapshot carries the migration records: only 0003 runs.
      expect(out.includes('running: 2/3 migrations done') || out.includes('done: 3/3'), out);
      expect(!out.includes('0/3'), `migrations from the snapshot ran again:\n${out}`);
      log(`  ${out.trim().split('\n').at(-1)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  /** `test-upgrade --seed <fn> --check <fn>` with internal functions, which only the admin key can call. */
  async internal() {
    const upgrade = (check: string) =>
      spawnSync(
        'node',
        [
          join(ROOT, 'packages/convex-release/dist/cli.mjs'),
          'test-upgrade',
          '--from',
          `${PREFIX}-app:v3`,
          '--to',
          `${PREFIX}-app:v4`,
          '--seed',
          'messages:seedInternal {"count": 50}',
          '--check',
          check,
        ],
        { cwd: join(ROOT, 'e2e/apps/v4'), env: { ...process.env, CI: '1' }, encoding: 'utf8' },
      );
    const passing = upgrade('messages:verifyInternal {"count": 50, "users": 10}');
    expect(passing.status === 0, `test-upgrade with internal functions failed:\n${passing.stdout}${passing.stderr}`);
    // A check that throws has to fail the test, or the passing run proves nothing.
    const failing = upgrade('messages:verifyInternal {"count": 51, "users": 10}');
    expect(failing.status !== 0 && `${failing.stdout}${failing.stderr}`.includes('expected 51 migrated messages'), 'a throwing --check passed');
    log('  internal --seed and --check run; a throwing --check fails the test');
  },

  /** What a preview environment uses: seeds on an empty volume, a reset on downgrade, a snapshot on first start. */
  async preview() {
    const seed = ['-e', 'CONVEX_RELEASE_SEED=true'];
    const has = (run: Run, text: string) => run.log.some((l) => l.includes(text));
    const seeded = await runCombined('v4', 'pr', seed);
    expect(seeded.healthy && has(seeded, 'seeded: 01_users (20), 02_messages (250)'), `seeding failed:\n${seeded.log.join('\n')}`);
    let summary = await check();
    expect(summary.wellFormed === 250 && summary.users === 20, `seeded data: ${JSON.stringify(summary)}`);
    log(`  first start seeds: ${JSON.stringify(summary)}`);

    const restarted = await runCombined('v4', 'pr', seed);
    expect(restarted.healthy && has(restarted, 'not seeding'), `restart seeded again:\n${restarted.log.join('\n')}`);
    expect((await check()).messages === 250, 'restart changed the data');
    log('  restart: not seeded again');

    // v3 lacks 0003, which the data has: refused by default, wiped with reset.
    const refused = await runCombined('v3', 'pr');
    expect(!refused.healthy && refused.exitCode === 1, `v3 should refuse without reset, got exit ${refused.exitCode}`);
    const reset = await runCombined('v3', 'pr', ['-e', 'CONVEX_RELEASE_ON_DOWNGRADE=reset']);
    expect(reset.healthy && has(reset, 'deleting all data'), `reset failed:\n${reset.log.join('\n')}`);
    const reseeded = await runCombined('v4', 'pr', seed);
    expect(has(reseeded, 'seeded:'), `v4 didn't find the reset volume empty:\n${reseeded.log.join('\n')}`);
    log('  v3 with reset: wiped; v4 seeded the empty volume again');

    // A v3 export as the preview's starting data: v4 imports it and runs 0003 alone.
    await runCombined('v1', 'src');
    await call('messages:seed', { chunk: 0, size: 300, authors: 15 });
    await runCombined('v3', 'src');
    const dir = mkdtempSync(join(tmpdir(), `${PREFIX}-snapshot-`));
    const zip = join(dir, 'prod.zip');
    try {
      sh(join(ROOT, 'e2e/apps/v3/node_modules/.bin/convex'), ['export', '--path', zip], {
        cwd: join(ROOT, 'e2e/apps/v3'),
        env: { ...process.env, CONVEX_SELF_HOSTED_URL: URL, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey(), CONVEX_DEPLOYMENT: '' },
      });
      const fromSnapshot = await runCombined('v4', 'pr2', ['-v', `${zip}:/snapshot.zip:ro`, '-e', 'CONVEX_RELEASE_SNAPSHOT=/snapshot.zip', ...seed]);
      expect(fromSnapshot.healthy, `snapshot start failed:\n${fromSnapshot.log.join('\n')}`);
      expect(has(fromSnapshot, 'imported snapshot.zip'), `no import:\n${fromSnapshot.log.join('\n')}`);
      expect(!has(fromSnapshot, '0/3') && has(fromSnapshot, 'not seeding'), fromSnapshot.log.join('\n'));
      summary = await check();
      expect(summary.wellFormed === 300 && summary.users === 15, `snapshot data: ${JSON.stringify(summary)}`);
      log(`  snapshot: imported and migrated, ${JSON.stringify(summary)}`);

      // A v4 export is newer than v3: the start fails and leaves the volume
      // empty, so pointing it at an older snapshot fixes it.
      const newer = join(dir, 'newer.zip');
      sh(join(ROOT, 'e2e/apps/v4/node_modules/.bin/convex'), ['export', '--path', newer], {
        cwd: join(ROOT, 'e2e/apps/v4'),
        env: { ...process.env, CONVEX_SELF_HOSTED_URL: URL, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey(), CONVEX_DEPLOYMENT: '' },
      });
      const tooNew = await runCombined('v3', 'pr3', ['-v', `${newer}:/snapshot.zip:ro`, '-e', 'CONVEX_RELEASE_SNAPSHOT=/snapshot.zip']);
      expect(!tooNew.healthy && has(tooNew, 'comes from a newer version'), `a newer snapshot should fail:\n${tooNew.log.join('\n')}`);
      const replaced = await runCombined('v3', 'pr3', ['-v', `${zip}:/snapshot.zip:ro`, '-e', 'CONVEX_RELEASE_SNAPSHOT=/snapshot.zip']);
      expect(replaced.healthy && has(replaced, 'imported snapshot.zip'), `replacing the snapshot didn't help:\n${replaced.log.join('\n')}`);
      log('  newer snapshot: start fails; replacing it works');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  /** The image build installs with the lockfile's package manager: npm, pnpm, Yarn 1 and Yarn 4. */
  async packageManagers() {
    for (const pm of Object.keys(PACKAGE_MANAGERS) as PackageManager[]) {
      buildApp('v4', 'combined', tarballs, pm);
      const run = await runCombined(`v4-${pm}`, `pm-${pm}`);
      expect(run.healthy, `${pm} build didn't become healthy:\n${run.log.join('\n')}`);
      await write('v4', 20);
      const summary = await check();
      expect(summary.wellFormed === 20, `${pm}: ${JSON.stringify(summary)}`);
      log(`  ${pm}: built and deployed`);
    }
  },

  async node() {
    await runCombined('v4', 'data');
    const out = await call<string>('nodeHash:sha256', { text: 'hi' });
    expect(out.startsWith('v'), out);
    log(`  Node action: ${out.slice(0, 40)}…`);
  },

  async oneshot() {
    const key = await startBackend();
    for (const version of ['v1', 'v4']) {
      const result = applyOneshot(version);
      expect(result.status === 0, `one-shot ${version} exited ${result.status}:\n${result.stdout}${result.stderr}`);
      log(`  one-shot ${version}: exit 0 (${result.stdout.trim().split('\n').at(-1)})`);
      await write(version, 100, key);
    }
    const summary = await check(key);
    expect(summary.wellFormed === 200 && summary.users === 100, JSON.stringify(summary));
    log(`  ${JSON.stringify(summary)}`);
  },

  /** A dependency's predeploy check refuses a combined image's start, and the skip setting overrides it. */
  async predeploy() {
    const v4 = await runCombined('v4', 'data');
    expect(v4.healthy, `v4 failed:\n${v4.log.join('\n')}`);
    await block(adminKey());

    const refused = await runCombined('v5', 'data');
    expect(!refused.healthy && refused.exitCode !== 0, `v5 should be refused, got exit ${refused.exitCode}:\n${refused.log.join('\n')}`);
    expectLines(
      refused.log,
      REFUSAL.map((line, i) => `[convex-release] ${i === 0 ? 'deploy failed: ' : ''}${line}`),
      'refusal',
    );
    const refusedAt = refused.log.findIndex((l) => l.includes('A predeploy check refused'));
    expect(!refused.log.slice(0, refusedAt).some((l) => l.includes('pushed')), `v5 pushed before the refusal:\n${refused.log.join('\n')}`);
    log('  v5 refused while the flag exists; nothing pushed');

    const skipped = await runCombined('v5', 'data', ['-e', 'CONVEX_RELEASE_SKIP_CHECKS=predeploy-fixture']);
    expect(skipped.healthy, `v5 with the skip failed:\n${skipped.log.join('\n')}`);
    expectLines(skipped.log, ['[convex-release] skipped the predeploy check of predeploy-fixture (CONVEX_RELEASE_SKIP_CHECKS)'], 'skip');
    expect((await liveVersion(adminKey())) === 'v5', 'v5 is not live after the skip');
    log('  CONVEX_RELEASE_SKIP_CHECKS: v5 deployed with a warning');

    await unblock(adminKey());
    const passed = await runCombined('v5', 'data');
    expect(passed.healthy, `v5 failed after unblocking:\n${passed.log.join('\n')}`);
    // The facts come from the image build: collect read v5's package.json there.
    expectLines(passed.log, ['[convex-release] [predeploy-fixture] checking e2e-app-v5'], 'facts');
    expect((await liveVersion(adminKey())) === 'v5', 'v5 is not live');
    log('  flag removed: v5 passes its check and starts');
  },

  /** The same refusal from the one-shot image, leaving the deployed code as it was. */
  async predeployOneshot() {
    const key = await startBackend();
    const v4 = applyOneshot('v4');
    expect(v4.status === 0, `one-shot v4 exited ${v4.status}:\n${v4.stdout}${v4.stderr}`);
    await block(key);

    const refused = applyOneshot('v5');
    expect(refused.status !== 0, `one-shot v5 should be refused:\n${refused.stdout}`);
    expectLines(refused.stdout.split('\n'), REFUSAL, 'refusal');
    expect((await liveVersion(key)) === 'older than v5', 'v5 code went live despite the refusal');
    log('  one-shot v5 refused; v4 code still live');

    await unblock(key);
    const passed = applyOneshot('v5');
    expect(passed.status === 0, `one-shot v5 exited ${passed.status}:\n${passed.stdout}${passed.stderr}`);
    expect((await liveVersion(key)) === 'v5', 'v5 is not live');
    log('  flag removed: one-shot v5 deploys');
  },

  /** CONVEX_RELEASE_PRE_PUSH and _POST_APPLY in the combined image: order, environment, the recorded version. */
  async hooks() {
    const first = await runCombined('v1', 'data', hooks());
    expect(first.healthy, `v1 with hooks failed:\n${first.log.join('\n')}`);
    expectLines(
      first.log,
      [
        '[convex-release] pre-push hook: running',
        '[hook] pre-push at http://127.0.0.1:3210: recorded version none',
        '[convex-release] pre-push hook: done',
        '[convex-release] push: pushed',
        '[convex-release] post-apply hook: running',
        '[hook] post-apply at http://127.0.0.1:3210: recorded version 1.0.0',
        '[convex-release] post-apply hook: done',
        '[convex-release] ready',
      ],
      'v1',
    );
    await write('v1', 50);
    const upgrade = await runCombined('v4', 'data', hooks());
    expect(upgrade.healthy, `v4 with hooks failed:\n${upgrade.log.join('\n')}`);
    // The pre-push hook runs before any of v4's code exists; post-apply after the data matches it.
    expectLines(
      upgrade.log,
      [
        '[hook] pre-push at http://127.0.0.1:3210: recorded version 1.0.0',
        'pass 1 (validation off): pushed',
        'done: 3/3',
        'pass 2 (validation on): pushed',
        '[hook] post-apply at http://127.0.0.1:3210: recorded version 4.0.0',
        '[convex-release] ready',
      ],
      'v4',
    );
    const key = adminKey();
    expect(!`${first.all}\n${upgrade.all}`.includes(key), 'the admin key is in the logs');
    expect((await getEnv('CONVEX_RELEASE_VERSION', key)) === '4.0.0', 'CONVEX_RELEASE_VERSION is not 4.0.0');
    log('  pre-push before the first push, post-apply before ready; both read the recorded version; the key is not logged');
  },

  /** A failing hook stops the release: before anything is pushed (pre-push), or before ready (post-apply). */
  async hookFailure() {
    expect((await runCombined('v1', 'data')).healthy, 'v1 failed');
    await write('v1', 50);
    const prePush = await runCombined('v4', 'data', hooks({ prePush: 'fail' }));
    expect(!prePush.healthy && prePush.exitCode === 1, `a failing pre-push hook should exit 1, got ${prePush.exitCode}`);
    expectLines(prePush.log, ['[hook] failing on purpose', '[convex-release] deploy failed: pre-push hook failed (exit 3)'], 'pre-push');
    expect(!prePush.log.some((l) => l.endsWith(': pushed')), `pushed despite the failed pre-push hook:\n${prePush.log.join('\n')}`);
    log('  pre-push exits 3: exit 1, nothing pushed');

    const postApply = await runCombined('v4', 'data', hooks({ postApply: 'fail' }));
    expect(!postApply.healthy && postApply.exitCode === 1, `a failing post-apply hook should exit 1, got ${postApply.exitCode}`);
    expectLines(postApply.log, ['pass 2 (validation on): pushed', '[hook] failing on purpose', 'deploy failed: post-apply hook failed (exit 3)'], 'post-apply');
    expect(!postApply.log.some((l) => l.endsWith('ready')), 'reported ready despite the failed post-apply hook');
    log('  post-apply exits 3: exit 1, never ready');

    const fixed = await runCombined('v4', 'data', hooks());
    expect(fixed.healthy, `v4 with working hooks failed:\n${fixed.log.join('\n')}`);
    expect((await check()).wellFormed === 50, 'data lost');
  },

  /** The same hooks in the one-shot image, against CONVEX_URL. */
  async hooksOneshot() {
    const key = await startBackend();
    const v1 = applyOneshot('v1', hooks());
    expect(v1.status === 0, `one-shot v1 with hooks exited ${v1.status}:\n${v1.stdout}${v1.stderr}`);
    const backendUrl = `http://${container('backend')}:3210`;
    expectLines(
      v1.stdout.split('\n'),
      [`[hook] pre-push at ${backendUrl}: recorded version none`, 'push: pushed', `[hook] post-apply at ${backendUrl}: recorded version 1.0.0`, 'deployed'],
      'one-shot v1',
    );
    expect(!`${v1.stdout}${v1.stderr}`.includes(key), 'the admin key is in the one-shot output');
    await write('v1', 50, key);
    const failed = applyOneshot('v4', hooks({ postApply: 'fail' }));
    expect(failed.status === 1, `a failing post-apply hook should exit 1, got ${failed.status}`);
    expectLines(failed.stdout.split('\n'), ['pass 2 (validation on): pushed', 'deploy failed: post-apply hook failed (exit 3)'], 'one-shot v4');
    expect((await getEnv('CONVEX_RELEASE_VERSION', key)) === '4.0.0', 'one-shot v4 did not record its version');
    log('  one-shot: hooks get CONVEX_URL; a failing post-apply hook exits 1');
  },

  /** CONVEX_RELEASE_BACKUP_DIR: an export per upgrade with pending migrations, the newest KEEP kept. */
  async backup() {
    expect((await runCombined('v1', 'data', backups(2))).healthy, 'v1 failed');
    await write('v1', 100);
    const taken: string[] = [];
    for (const [version, from] of [
      ['v2', '1.0.0'],
      ['v3', '2.0.0'],
    ] as const) {
      const run = await runCombined(version, 'data', backups(2));
      expect(run.healthy, `${version} failed:\n${run.log.join('\n')}`);
      const wrote = run.log.find((l) => l.includes('backup: wrote '));
      expect(Boolean(wrote?.endsWith(`-${from}-to-${version[1]}.0.0.zip`)), `${version}: no backup from ${from}:\n${run.log.join('\n')}`);
      expectLines(run.log, ['backup: wrote', 'pass 1 (validation off): pushed'], `${version} order`);
      taken.push(wrote!.split('backup: wrote ')[1]!);
    }
    const again = await runCombined('v3', 'data', backups(2));
    expect(again.healthy && !again.log.some((l) => l.includes('backup:')), `a restart without pending migrations took a backup:\n${again.log.join('\n')}`);
    const v4 = await runCombined('v4', 'data', backups(2));
    expect(v4.healthy, `v4 failed:\n${v4.log.join('\n')}`);
    expectLines(v4.log, [`backup: deleted ${taken[0]} (CONVEX_RELEASE_BACKUP_KEEP=2)`], 'rotation');
    const files = listBackups();
    expect(files.length === 2 && files[0] === taken[1] && files[1]!.endsWith('-3.0.0-to-4.0.0.zip'), `backups: ${files.join(', ')}`);
    const key = adminKey();
    expect((await getEnv('CONVEX_RELEASE_VERSION', key)) === '4.0.0' && (await getEnv('CONVEX_RELEASE_BACKUP', key)) === undefined, 'records after v4');
    log(`  ${files.join(', ')}; no backup without pending migrations`);
  },

  /**
   * A migration fails and the container restarts, then a fix release fails too: five attempts on one
   * backup, which KEEP=3 never rotates out. The DC-1 case of omnarr's D7 review.
   */
  async crashLoop() {
    await runCombined('v1', 'data');
    await write('v1', 300);
    expect((await runCombined('v2', 'data')).healthy, 'v2 failed');
    // Three earlier upgrades' backups.
    inBackups('for f in 20240101-000000-0.1.0-to-0.2.0 20250101-000000-0.2.0-to-0.3.0 20250601-000000-0.3.0-to-1.0.0; do echo old > /backups/$f.zip; done');
    await setEnv('FAIL_AT', 'user150');
    let clean = '';
    let hash = '';
    for (const [attempt, version] of ['v4', 'v4', 'v4', 'v5', 'v5'].entries()) {
      const run = await runCombined(version, 'data', backups(3));
      expect(!run.healthy && run.exitCode === 1, `${version} attempt ${attempt + 1} should fail, got exit ${run.exitCode}:\n${run.log.join('\n')}`);
      expect(
        run.log.some((l) => l.includes('FAIL_AT reached')),
        `attempt ${attempt + 1} failed for another reason:\n${run.log.join('\n')}`,
      );
      if (attempt === 0) {
        clean = run.log.find((l) => l.includes('backup: wrote '))!.split('backup: wrote ')[1]!;
        expect(clean.endsWith('-2.0.0-to-4.0.0.zip'), `first backup: ${clean}`);
        hash = backupHash(clean);
      } else {
        expectLines(run.log, [`backup: reusing ${clean}, taken before an earlier attempt at this upgrade`], `attempt ${attempt + 1}`);
      }
    }
    const files = listBackups();
    expect(
      JSON.stringify(files) === JSON.stringify(['20250101-000000-0.2.0-to-0.3.0.zip', '20250601-000000-0.3.0-to-1.0.0.zip', clean]),
      `after five attempts: ${files.join(', ')}`,
    );
    expect(backupHash(clean) === hash, 'the clean backup changed');
    log(`  5 failed attempts (3x v4, 2x v5): one backup, ${clean}, unchanged`);

    await bareBackend('v5');
    await setEnv('FAIL_AT', null);
    const fixed = await runCombined('v5', 'data', backups(3));
    expect(fixed.healthy, `v5 didn't recover:\n${fixed.log.join('\n')}`);
    const key = adminKey();
    expect((await getEnv('CONVEX_RELEASE_VERSION', key)) === '5.0.0', 'CONVEX_RELEASE_VERSION after the fix');
    expect((await getEnv('CONVEX_RELEASE_BACKUP', key)) === undefined, 'CONVEX_RELEASE_BACKUP not cleared after success');
    expect(listBackups().length === 3 && (await check(key)).wellFormed === 300, 'data or backups after the fix');
    log('  v5 succeeds once fixed: version 5.0.0 recorded, backup record cleared');
  },

  /** A backup taken before an upgrade restores the data and the components' tables through CONVEX_RELEASE_SNAPSHOT. */
  async restore() {
    await runCombined('v1', 'data');
    await write('v1', 120);
    expect((await runCombined('v2', 'data')).healthy, 'v2 failed');
    const upgraded = await runCombined('v4', 'data', backups());
    expect(upgraded.healthy, `v4 failed:\n${upgraded.log.join('\n')}`);
    const file = listBackups()[0]!;
    expect(file.endsWith('-2.0.0-to-4.0.0.zip'), `backup: ${file}`);

    // CUJ 7 of omnarr's D7: back to v2 on an empty volume, from the export taken before v4.
    const restored = await runCombined('v2', 'restored', ['-v', `${BACKUPS}:/backups:ro`, '-e', `CONVEX_RELEASE_SNAPSHOT=/backups/${file}`]);
    expect(restored.healthy, `restore failed:\n${restored.log.join('\n')}`);
    expectLines(restored.log, [`imported ${file}`], 'import');
    const key = adminKey();
    expect((await tableSize('messages', key)) === 120, 'restored message count');
    const records = await call<{ name: string; isDone: boolean }[]>('lib:getStatus', { limit: 100 }, key, URL, 'migrations');
    expect(
      records.length === 1 && records[0]!.name === 'migrations/0001_rename_body_to_text' && records[0]!.isDone,
      `the migrations component's records: ${JSON.stringify(records)}`,
    );
    expect((await getEnv('CONVEX_RELEASE_VERSION', key)) === '2.0.0' && (await getEnv('CONVEX_RELEASE_BACKUP', key)) === undefined, 'records after restore');
    log('  v2 restored from the backup: 120 messages, migration 0001 recorded as done');

    // The restored deployment upgrades again, as the original did.
    const again = await runCombined('v4', 'restored');
    expect(again.healthy && (await check()).wellFormed === 120, `upgrading the restored deployment failed:\n${again.log.join('\n')}`);
    log('  and upgrades to v4 again');
  },

  /** `check`, `dev` and `deploy` from a checkout, against a running v4. */
  async predeployCli() {
    const v4 = await runCombined('v4', 'data');
    expect(v4.healthy, `v4 failed:\n${v4.log.join('\n')}`);
    const key = adminKey();
    await block(key);
    const app = join(ROOT, 'e2e/apps/v5');
    const cli = (...args: string[]) => {
      const result = spawnSync('node', [join(ROOT, 'packages/convex-release/dist/cli.mjs'), ...args], {
        cwd: app,
        encoding: 'utf8',
        env: { ...process.env, CI: '1', CONVEX_SELF_HOSTED_URL: URL, CONVEX_SELF_HOSTED_ADMIN_KEY: key, CONVEX_DEPLOYMENT: '', CONVEX_DEPLOY_KEY: '' },
      });
      return { status: result.status, lines: `${result.stdout}\n${result.stderr}`.split('\n') };
    };
    try {
      const checked = cli('check');
      expect(checked.status === 1, `check should exit 1, got ${checked.status}:\n${checked.lines.join('\n')}`);
      expectLines(checked.lines, ['predeploy-fixture: blocked by a flag'], 'check');

      const checkSkipped = cli('check', '--skip-check', 'predeploy-fixture');
      expect(checkSkipped.status === 0, `check --skip-check should exit 0, got ${checkSkipped.status}:\n${checkSkipped.lines.join('\n')}`);
      expectLines(checkSkipped.lines, ['predeploy-fixture: skipped'], 'check --skip-check');
      log('  check: reports the failed check (exit 1), and the skipped one');

      for (const command of [['dev', '--once'], ['deploy']]) {
        const refused = cli(...command);
        expect(refused.status === 1, `${command.join(' ')} should exit 1, got ${refused.status}:\n${refused.lines.join('\n')}`);
        expectLines(refused.lines, REFUSAL, command.join(' '));
        expect((await liveVersion(key)) === 'older than v5', `${command.join(' ')} pushed v5 despite the refusal`);
      }
      log('  dev --once and deploy: refused, nothing pushed');

      const skipped = cli('deploy', '--skip-check', 'predeploy-fixture');
      expect(skipped.status === 0, `deploy --skip-check exited ${skipped.status}:\n${skipped.lines.join('\n')}`);
      expectLines(skipped.lines, ['skipped the predeploy check of predeploy-fixture (--skip-check)'], 'deploy --skip-check');
      expect((await liveVersion(key)) === 'v5', 'v5 is not live after deploy --skip-check');
      log('  deploy --skip-check: v5 deployed with a warning');
    } finally {
      // `convex dev` saves the deployment's URLs next to the app.
      rmSync(join(app, '.env.local'), { force: true });
    }
  },
};

// ------------------------------------------------------------------- main ---

const wanted = process.argv.slice(2);
const selected = wanted.length > 0 ? wanted : Object.keys(scenarios);
for (const name of selected) if (!scenarios[name]) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(', ')}`);

buildImages();
const tarballs: Tarballs = {
  '@dev-marzahn/convex-release': packTarball('packages/convex-release'),
  'predeploy-fixture': packTarball('e2e/libs/predeploy-fixture'),
};
const oneshot = new Set([
  ...(selected.includes('oneshot') || selected.includes('hooksOneshot') ? ['v1', 'v4'] : []),
  ...(selected.includes('predeployOneshot') ? ['v4', 'v5'] : []),
]);
for (const version of ['v1', 'v2', 'v3', 'v4', 'v5']) {
  buildApp(version, 'combined', tarballs);
  if (oneshot.has(version)) buildApp(version, 'oneshot', tarballs);
}
log('built fixture apps v1-v5');

const failures: string[] = [];
for (const name of selected) {
  removeAll();
  log(`\n${name}`);
  try {
    await scenarios[name]!();
    log(`  ✔ ${name}`);
  } catch (err) {
    failures.push(name);
    log(`  ✖ ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
removeAll();
for (const tarball of Object.values(tarballs)) rmSync(dirname(tarball), { recursive: true, force: true });
log(`\n${selected.length - failures.length}/${selected.length} scenarios passed${failures.length ? `; failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
