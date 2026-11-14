#!/usr/bin/env node
// Entrypoint of the release images. Applies the push requests baked into the
// image (written by `convex-release bundle` at build time) in the same three
// steps as `convex-release deploy`: push with schema validation off, run the
// pending migrations, push with validation on.
//
// Two modes:
//   combined: starts the backend in this container (./run_backend.sh), applies
//             the release, then keeps running it. Ready once applied.
//   one-shot: CONVEX_URL is set; applies the release to that backend and exits.
//
// Any failure exits non-zero, so neither mode reports success on a half-applied
// release. Restarting runs everything again: pushes are idempotent and finished
// migrations are skipped.
//
// No dependencies beyond Node: this runs in the backend image as it is.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const START = 'migrations/_generated:start';
const STATUS = 'migrations/_generated:status';
const PUSH_FILE = process.env.CONVEX_RELEASE_PUSH ?? '/convex/app/push.json';
const RELAXED_FILE = PUSH_FILE.replace(/\.json$/, '.relaxed.json');
const MANIFEST_FILE = PUSH_FILE.replace(/[^/]+$/, 'release.json');
const READY_FILE = process.env.CONVEX_RELEASE_READY_FILE ?? '/tmp/convex-ready';
const POLL_MS = 1000;
/** A read right after `start` can still show the previous run's failure. */
const FAILED_READS = 3;

interface ReleaseStatus {
  state: 'running' | 'done' | 'failed';
  message?: string;
}

const log = (message: string) => console.log(`[convex-release] ${message}`);

async function waitForBackend(url: string) {
  for (;;) {
    try {
      if ((await fetch(`${url}/version`)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
}

async function post<T>(url: string, path: string, body: object, key: string): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Convex-Client': 'convex-release', Authorization: `Convex ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${text.slice(0, 2000)}`);
  return JSON.parse(text) as T;
}

async function push(url: string, key: string, request: object, label: string) {
  const start = await post<{ schemaChange: unknown }>(url, '/api/deploy2/start_push', { ...request, adminKey: key }, key);
  for (;;) {
    const s = await post<{ type: string }>(url, '/api/deploy2/wait_for_schema', { adminKey: key, schemaChange: start.schemaChange, timeoutMs: 10_000 }, key);
    if (s.type === 'complete') break;
    if (s.type !== 'inProgress') throw new Error(`schema ${s.type}: ${JSON.stringify(s).slice(0, 2000)}`);
    log(`${label}: waiting for schema validation and index backfill`);
  }
  await post(url, '/api/deploy2/finish_push', { adminKey: key, startPush: start, dryRun: false, message: `convex-release: ${label}` }, key);
  log(`${label}: pushed`);
}

async function call<T>(url: string, key: string, path: string): Promise<T> {
  const r = await post<{ status: string; value: T; errorMessage?: string }>(url, '/api/function', { path, format: 'convex_encoded_json', args: {} }, key);
  if (r.status !== 'success') throw new Error(`${path}: ${r.errorMessage}`);
  return r.value;
}

async function runMigrations(url: string, key: string) {
  await call(url, key, START);
  let last = '';
  let failedReads = 0;
  for (;;) {
    const { state, message = '' } = await call<ReleaseStatus>(url, key, STATUS);
    if (state === 'failed') {
      if (++failedReads < FAILED_READS) {
        await sleep(POLL_MS);
        continue;
      }
      throw new Error(message || 'migrations failed');
    }
    failedReads = 0;
    const line = `${state}: ${message}`;
    if (line !== last) log((last = line));
    if (state === 'done') return;
    await sleep(POLL_MS);
  }
}

/** The migrations the deployment has recorded, straight from the component. */
async function recordedMigrations(url: string, key: string): Promise<{ name: string; isDone: boolean }[]> {
  try {
    const r = await post<{ status: string; value: { name: string; isDone: boolean }[] }>(
      url,
      '/api/function',
      { componentPath: 'migrations', path: 'lib:getStatus', format: 'json', args: { limit: 1000 } },
      key,
    );
    return r.status === 'success' ? r.value : [];
  } catch {
    // No migrations component yet (the backend answers 500): a fresh
    // deployment, or one never released with convex-release. A real outage
    // fails the push that follows, and `status` checks again after pass 1.
    return [];
  }
}

/**
 * Refuses an older release before anything is pushed: if the data has
 * finished migrations this release doesn't know, a newer one shipped them.
 */
async function assertNotDowngrade(url: string, key: string) {
  if (!existsSync(MANIFEST_FILE)) return;
  const known = new Set((JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as { migrations: string[] }).migrations);
  const newer = (await recordedMigrations(url, key)).filter((s) => s.isDone && !known.has(s.name)).map((s) => s.name);
  if (newer.length > 0) {
    throw new Error(
      `the data was upgraded by a newer release (migrations not in this one: ${newer.join(', ')}). Run that release or a newer one; nothing was pushed.`,
    );
  }
}

async function apply(url: string, key: string) {
  await waitForBackend(url);
  await assertNotDowngrade(url, key);
  const request = JSON.parse(readFileSync(PUSH_FILE, 'utf8')) as object;
  if (existsSync(RELAXED_FILE)) {
    await push(url, key, JSON.parse(readFileSync(RELAXED_FILE, 'utf8')) as object, 'pass 1 (validation off)');
    await runMigrations(url, key);
    await push(url, key, request, 'pass 2 (validation on)');
  } else {
    await push(url, key, request, 'push');
  }
}

function lastLine(output: string): string {
  return output.trim().split('\n').at(-1) ?? '';
}

async function oneShot(url: string) {
  // The backend's own credentials derive the admin key, so the release needs
  // nothing beyond what the backend container already has.
  const name = process.env.INSTANCE_NAME;
  const secret = process.env.INSTANCE_SECRET;
  const key =
    process.env.CONVEX_ADMIN_KEY ?? (name && secret ? lastLine(execFileSync('/convex/generate_key', [name, secret], { encoding: 'utf8' })) : undefined);
  if (!key) throw new Error("Set INSTANCE_NAME and INSTANCE_SECRET (the backend's), or CONVEX_ADMIN_KEY.");
  log(`releasing to ${url}`);
  await apply(url.replace(/\/+$/, ''), key);
  log('released');
}

function combined() {
  rmSync(READY_FILE, { force: true });
  const backend: ChildProcess = spawn('./run_backend.sh', { stdio: 'inherit' });
  let failed = false;
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => backend.kill(sig));
  backend.on('exit', (code, signal) => {
    log(`backend exited (${signal ?? code})`);
    process.exit(failed ? 1 : (code ?? 1));
  });
  const key = lastLine(execFileSync('./generate_admin_key.sh', { encoding: 'utf8' }));
  apply(`http://127.0.0.1:${process.env.PORT ?? 3210}`, key)
    .then(() => {
      writeFileSync(READY_FILE, new Date().toISOString());
      log('ready');
    })
    .catch((err: unknown) => {
      failed = true;
      log(`release failed: ${err instanceof Error ? err.message : String(err)}`);
      backend.kill('SIGINT');
      setTimeout(() => process.exit(1), 10_000).unref();
    });
}

if (process.env.CONVEX_URL) {
  oneShot(process.env.CONVEX_URL).catch((err: unknown) => {
    log(`release failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  combined();
}
