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
// For previews, three opt-in settings:
//   CONVEX_RELEASE_SNAPSHOT=<path or URL>  import a `convex export` zip into an
//                                          empty deployment before migrating;
//   CONVEX_RELEASE_SEED=true               run the app's seeds on an empty one;
//   CONVEX_RELEASE_ON_DOWNGRADE=reset      wipe the data instead of refusing
//                                          a release older than the data.
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
const SEED = 'seeds/_generated:run';
const PUSH_FILE = process.env.CONVEX_RELEASE_PUSH ?? '/convex/app/push.json';
const RELAXED_FILE = PUSH_FILE.replace(/\.json$/, '.relaxed.json');
const MANIFEST_FILE = PUSH_FILE.replace(/[^/]+$/, 'release.json');
const READY_FILE = process.env.CONVEX_RELEASE_READY_FILE ?? '/tmp/convex-ready';
const SNAPSHOT = process.env.CONVEX_RELEASE_SNAPSHOT || undefined;
const SEED_ON_EMPTY = /^(1|true|yes)$/i.test(process.env.CONVEX_RELEASE_SEED ?? '');
const ON_DOWNGRADE = process.env.CONVEX_RELEASE_ON_DOWNGRADE ?? 'refuse';
const POLL_MS = 1000;
/** A read right after `start` can still show the previous run's failure. */
const FAILED_READS = 3;
const UPLOAD_CHUNK = 5 * 1024 * 1024;

interface ReleaseStatus {
  state: 'running' | 'done' | 'failed';
  message?: string;
}

interface Manifest {
  migrations: string[];
  seeds?: boolean;
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

async function request<T>(url: string, path: string, key: string, init: { body?: Uint8Array; json?: object } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Convex-Client': 'convex-release', Authorization: `Convex ${key}` };
  let body: Uint8Array | string | undefined = init.body;
  if (init.json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  } else if (body) {
    headers['Content-Type'] = 'application/octet-stream';
  }
  const res = await fetch(`${url}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${text.slice(0, 2000)}`);
  return (text ? JSON.parse(text) : null) as T;
}

const post = <T>(url: string, path: string, body: object, key: string) => request<T>(url, path, key, { json: body });

async function push(url: string, key: string, req: object, label: string) {
  const start = await post<{ schemaChange: unknown }>(url, '/api/deploy2/start_push', { ...req, adminKey: key }, key);
  for (;;) {
    const s = await post<{ type: string }>(url, '/api/deploy2/wait_for_schema', { adminKey: key, schemaChange: start.schemaChange, timeoutMs: 10_000 }, key);
    if (s.type === 'complete') break;
    if (s.type !== 'inProgress') throw new Error(`schema ${s.type}: ${JSON.stringify(s).slice(0, 2000)}`);
    log(`${label}: waiting for schema validation and index backfill`);
  }
  await post(url, '/api/deploy2/finish_push', { adminKey: key, startPush: start, dryRun: false, message: `convex-release: ${label}` }, key);
  log(`${label}: pushed`);
}

async function call<T>(url: string, key: string, path: string, args: object = {}, endpoint = '/api/function'): Promise<T> {
  const r = await post<{ status: string; value: T; errorMessage?: string }>(url, endpoint, { path, format: 'json', args }, key);
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

function readManifest(): Manifest | undefined {
  return existsSync(MANIFEST_FILE) ? (JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Manifest) : undefined;
}

/**
 * Refuses an older release before anything is pushed: if the data has
 * finished migrations this release doesn't know, a newer one shipped them.
 * With CONVEX_RELEASE_ON_DOWNGRADE=reset, any unknown migration (a preview
 * whose branch renamed or dropped one) wipes the data instead. Not after a
 * snapshot import: a snapshot newer than the release would be imported and
 * wiped again on every start.
 */
async function checkDowngrade(url: string, key: string, after: 'start' | 'snapshot' = 'start') {
  const manifest = readManifest();
  if (!manifest) return;
  const known = new Set(manifest.migrations);
  const unknown = (await recordedMigrations(url, key)).filter((s) => !known.has(s.name));
  if (after === 'start' && ON_DOWNGRADE === 'reset' && unknown.length > 0) {
    log(`the data has migrations this release doesn't (${unknown.map((s) => s.name).join(', ')}); CONVEX_RELEASE_ON_DOWNGRADE=reset: deleting all data`);
    await importZip(url, key, emptyZip(), 'an empty snapshot');
    return;
  }
  const newer = unknown
    .filter((s) => s.isDone)
    .map((s) => s.name)
    .join(', ');
  if (!newer) return;
  if (after === 'snapshot') {
    throw new Error(
      `CONVEX_RELEASE_SNAPSHOT comes from a newer version of the app (migrations not in this one: ${newer}). Export it from this version or an older one.`,
    );
  }
  throw new Error(
    `the data was upgraded by a newer version of the app (migrations not in this one: ${newer}). Run that version or a newer one; nothing was pushed.`,
  );
}

/** True when no table in the app (outside components) has a document. */
async function isEmpty(url: string, key: string): Promise<boolean> {
  let cursor: string | null = null;
  for (;;) {
    const page: { page: { name: string }[]; isDone: boolean; continueCursor: string } = await call(
      url,
      key,
      '_system/cli/tables',
      { paginationOpts: { numItems: 100, cursor } },
      '/api/query',
    );
    for (const table of page.page) {
      if ((await call<number>(url, key, '_system/cli/tableSize:default', { tableName: table.name }, '/api/query')) > 0) return false;
    }
    if (page.isDone) return true;
    cursor = page.continueCursor;
  }
}

/** A zip with no entries: replacing everything with it deletes all documents. */
function emptyZip(): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  return end;
}

async function readSnapshot(source: string): Promise<Buffer> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`CONVEX_RELEASE_SNAPSHOT: ${source} answered HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!existsSync(source)) throw new Error(`CONVEX_RELEASE_SNAPSHOT: no file at ${source}`);
  return readFileSync(source);
}

type ImportState =
  | { state: 'uploaded' | 'in_progress'; progress_message?: string }
  | { state: 'waiting_for_confirmation'; message_to_confirm?: string }
  | { state: 'completed'; num_rows_written: number }
  | { state: 'failed'; error_message: string };

/** `convex import --replace-all`, over the same HTTP API the CLI uses. */
async function importZip(url: string, key: string, zip: Buffer, label: string) {
  const { uploadToken } = await request<{ uploadToken: string }>(url, '/api/import/start_upload', key);
  const partTokens: unknown[] = [];
  for (let offset = 0, part = 1; offset < zip.length || part === 1; offset += UPLOAD_CHUNK, part++) {
    const path = `/api/import/upload_part?uploadToken=${encodeURIComponent(uploadToken)}&partNumber=${part}`;
    partTokens.push(await request(url, path, key, { body: zip.subarray(offset, offset + UPLOAD_CHUNK) }));
  }
  const { importId } = await post<{ importId: string }>(
    url,
    '/api/import/finish_upload',
    { import: { mode: 'replaceAll', format: 'zip' }, uploadToken, partTokens },
    key,
  );
  let confirmed = false;
  let last = '';
  for (;;) {
    const { state } = await call<{ state: ImportState }>(url, key, '_system/cli/queryImport', { importId }, '/api/query');
    if (state.state === 'completed') {
      log(`imported ${label}: ${state.num_rows_written} documents`);
      return;
    }
    if (state.state === 'failed') throw new Error(`importing ${label} failed: ${state.error_message}`);
    if (state.state === 'waiting_for_confirmation' && !confirmed) {
      await post(url, '/api/perform_import', { importId }, key);
      confirmed = true;
    }
    const line = 'progress_message' in state ? (state.progress_message ?? '') : '';
    if (line && line !== last) log(`importing ${label}: ${(last = line)}`);
    await sleep(POLL_MS);
  }
}

async function apply(url: string, key: string) {
  await waitForBackend(url);
  await checkDowngrade(url, key);
  const strict = JSON.parse(readFileSync(PUSH_FILE, 'utf8')) as object;
  const relaxed = existsSync(RELAXED_FILE) ? (JSON.parse(readFileSync(RELAXED_FILE, 'utf8')) as object) : undefined;
  await push(url, key, relaxed ?? strict, relaxed ? 'pass 1 (validation off)' : 'push');
  if (SNAPSHOT && (await isEmpty(url, key))) {
    // After pass 1, so the migrations component exists to take its records.
    await importZip(url, key, await readSnapshot(SNAPSHOT), SNAPSHOT.split('/').at(-1)!);
    await checkDowngrade(url, key, 'snapshot');
  }
  if (relaxed) {
    await runMigrations(url, key);
    await push(url, key, strict, 'pass 2 (validation on)');
  }
  if (SEED_ON_EMPTY) await seed(url, key);
}

async function seed(url: string, key: string) {
  if (!readManifest()?.seeds) {
    log('CONVEX_RELEASE_SEED is set, but this release has no seeds');
    return;
  }
  const result = await call<{ seeded: boolean; reason?: string; seeds: { name: string; documents: number }[] }>(url, key, SEED, { force: false });
  if (!result.seeded) log(`not seeding: ${result.reason}`);
  else log(`seeded: ${result.seeds.map((s) => `${s.name.replace(/^seeds\//, '')} (${s.documents})`).join(', ')}`);
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
  log(`deploying to ${url}`);
  await apply(url.replace(/\/+$/, ''), key);
  log('deployed');
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
      log(`deploy failed: ${err instanceof Error ? err.message : String(err)}`);
      backend.kill('SIGINT');
      setTimeout(() => process.exit(1), 10_000).unref();
    });
}

if (process.env.CONVEX_URL) {
  oneShot(process.env.CONVEX_URL).catch((err: unknown) => {
    log(`deploy failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  combined();
}
