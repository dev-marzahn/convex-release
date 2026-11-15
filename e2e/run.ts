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
  log: string[];
}

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
      const lines = docker('logs', name)
        .split('\n')
        .concat(spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stderr.split('\n'));
      return { healthy: state[0] === 'healthy', exitCode: Number(state[2]), log: lines.filter((l) => l.startsWith('[convex-release]')) };
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

/** Applies a one-shot app image to the backend `startBackend` started. */
function applyOneshot(version: string) {
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
      `${PREFIX}-app:${version}-oneshot`,
    ],
    { encoding: 'utf8' },
  );
}

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
    const bare = container('app');
    spawnSync('docker', ['rm', '-f', bare], { stdio: 'ignore' });
    docker(
      'run',
      '-d',
      '--name',
      bare,
      '-p',
      `${PORT}:3210`,
      '-e',
      'INSTANCE_NAME=e2e',
      '-e',
      `INSTANCE_SECRET=${SECRET}`,
      '-v',
      `${PREFIX}-data:/convex/data`,
      '--entrypoint',
      './run_backend.sh',
      `${PREFIX}-app:v4`,
    );
    while (
      !(await fetch(`${URL}/version`).then(
        (r) => r.ok,
        () => false,
      ))
    )
      await sleep(500);
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
const oneshot = new Set([...(selected.includes('oneshot') ? ['v1', 'v4'] : []), ...(selected.includes('predeployOneshot') ? ['v4', 'v5'] : [])]);
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
