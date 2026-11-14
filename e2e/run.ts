// End-to-end tests of the release images: fixture apps v1-v4 are built from
// the images exactly as a user's app would be, then upgraded on real data.
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

/** A standalone build context for a fixture app, as a user's repo would look. */
function buildApp(version: string, base: 'combined' | 'oneshot', tarball: string) {
  const context = mkdtempSync(join(tmpdir(), `${PREFIX}-${version}-`));
  try {
    cpSync(join(ROOT, 'e2e/apps', version), context, { recursive: true, filter: (src) => !src.includes('node_modules') });
    cpSync(tarball, join(context, 'convex-release.tgz'));
    const catalog = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { catalog: Record<string, string> }).catalog;
    const manifest = JSON.parse(readFileSync(join(context, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        manifest[field]![name] = range === 'workspace:*' ? 'file:./convex-release.tgz' : range === 'catalog:' ? catalog[name]! : range;
      }
    }
    writeFileSync(join(context, 'package.json'), JSON.stringify(manifest, null, 2));
    writeFileSync(join(context, 'Dockerfile'), `FROM ${PREFIX}:${base}\n`);
    writeFileSync(join(context, '.dockerignore'), 'node_modules\n');
    docker('build', '-q', '-t', `${PREFIX}-app:${version}${base === 'oneshot' ? '-oneshot' : ''}`, context);
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

function packTarball(): string {
  const dir = mkdtempSync(join(tmpdir(), `${PREFIX}-pack-`));
  sh('bun', ['pm', 'pack', '--destination', dir, '--quiet'], { cwd: join(ROOT, 'packages/convex-release') });
  const file = sh('ls', [dir]).trim().split('\n')[0]!;
  return join(dir, file);
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

async function call<T>(path: string, args: object, key = adminKey(), url = URL): Promise<T> {
  const res = await fetch(`${url}/api/function`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Convex ${key}` },
    body: JSON.stringify({ path, format: 'json', args }),
  });
  const r = (await res.json()) as { status: string; value: T; errorMessage?: string };
  if (r.status !== 'success') throw new Error(`${path}: ${r.errorMessage}`);
  return r.value;
}

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
      const refusal = older.log.find((l) => l.includes('newer release'));
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async node() {
    await runCombined('v4', 'data');
    const out = await call<string>('nodeHash:sha256', { text: 'hi' });
    expect(out.startsWith('v'), out);
    log(`  Node action: ${out.slice(0, 40)}…`);
  },

  async oneshot() {
    docker('network', 'create', `${PREFIX}-net`);
    const backend = container('backend');
    docker(
      'run',
      '-d',
      '--name',
      backend,
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
    const key = adminKey(backend);
    for (const version of ['v1', 'v4']) {
      const result = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          `${PREFIX}-net`,
          '-e',
          `CONVEX_URL=http://${backend}:3210`,
          '-e',
          'INSTANCE_NAME=e2e',
          '-e',
          `INSTANCE_SECRET=${SECRET}`,
          `${PREFIX}-app:${version}-oneshot`,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status === 0, `one-shot ${version} exited ${result.status}:\n${result.stdout}${result.stderr}`);
      log(`  one-shot ${version}: exit 0 (${result.stdout.trim().split('\n').at(-1)})`);
      await write(version, 100, key);
    }
    const summary = await check(key);
    expect(summary.wellFormed === 200 && summary.users === 100, JSON.stringify(summary));
    log(`  ${JSON.stringify(summary)}`);
  },
};

// ------------------------------------------------------------------- main ---

const wanted = process.argv.slice(2);
const selected = wanted.length > 0 ? wanted : Object.keys(scenarios);
for (const name of selected) if (!scenarios[name]) throw new Error(`unknown scenario ${name}; known: ${Object.keys(scenarios).join(', ')}`);

buildImages();
const tarball = packTarball();
const needs = new Set(selected.includes('oneshot') ? ['oneshot'] : []);
for (const version of ['v1', 'v2', 'v3', 'v4']) {
  buildApp(version, 'combined', tarball);
  if (needs.has('oneshot') && (version === 'v1' || version === 'v4')) buildApp(version, 'oneshot', tarball);
}
log('built fixture apps v1-v4');

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
rmSync(dirname(tarball), { recursive: true, force: true });
log(`\n${selected.length - failures.length}/${selected.length} scenarios passed${failures.length ? `; failed: ${failures.join(', ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
