#!/usr/bin/env node
// Entrypoint of the release images. Applies the push requests baked into the
// image (written by `convex-release bundle` at build time) in the same three
// steps as `convex-release deploy`: push with schema validation off, run the
// pending migrations, push with validation on. ./apply.ts orders the steps;
// this file makes them HTTP calls to the backend and runs the process.
//
// Two modes:
//   combined: starts the backend in this container (./run_backend.sh), applies
//             the release, then keeps running it. Ready once applied.
//   one-shot: CONVEX_URL is set; applies the release to that backend and exits.
//
// For any installation:
//   CONVEX_RELEASE_PRE_PUSH=<command>      run before the first push, and
//   CONVEX_RELEASE_POST_APPLY=<command>    after the release, before ready
//                                          (`sh -c`, with CONVEX_URL and
//                                          CONVEX_ADMIN_KEY in the environment);
//   CONVEX_RELEASE_BACKUP_DIR=<folder>     export the deployment there before
//                                          migrating; CONVEX_RELEASE_BACKUP_KEEP
//                                          (default 3) are kept.
//
// For previews, three opt-in settings:
//   CONVEX_RELEASE_SNAPSHOT=<path or URL>  import a `convex export` zip into an
//                                          empty deployment before migrating;
//   CONVEX_RELEASE_SEED=true               run the app's seeds on an empty one;
//   CONVEX_RELEASE_ON_DOWNGRADE=reset      wipe the data instead of refusing
//                                          a release older than the data.
//
// And one for any installation:
//   CONVEX_RELEASE_SKIP_CHECKS=<pkg>,<pkg>  don't run these dependencies'
//                                          predeploy checks (after confirming
//                                          the release is safe).
//
// Before pass 1, the dependencies' predeploy checks run (bundled next to
// push.json with their facts); any failure refuses the release.
//
// Any failure exits non-zero, so neither mode reports success on a half-applied
// release. Restarting runs everything again: pushes are idempotent and finished
// migrations are skipped.
//
// No dependencies beyond Node: this runs in the backend image as it is.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  apiSpecIdentifier,
  applySkips,
  COMPONENT_NOT_DEPLOYED,
  parseSkipList,
  QueryError,
  refusal,
  runChecks,
  type CollectedCheck,
  type PredeployTransport,
} from '../predeploy.ts';
import { modeFromEnv, readSettings, run, type Deployment, type Mode, type Settings } from './apply.ts';
import type { ExportStream } from './backup.ts';
import { runHook } from './hooks.ts';

const START = 'migrations/_generated:start';
const STATUS = 'migrations/_generated:status';
const SEED = 'seeds/_generated:run';
const PUSH_FILE = process.env.CONVEX_RELEASE_PUSH ?? '/convex/app/push.json';
const RELAXED_FILE = PUSH_FILE.replace(/\.json$/, '.relaxed.json');
const MANIFEST_FILE = PUSH_FILE.replace(/[^/]+$/, 'release.json');
const READY_FILE = process.env.CONVEX_RELEASE_READY_FILE ?? '/tmp/convex-ready';
const ON_DOWNGRADE = process.env.CONVEX_RELEASE_ON_DOWNGRADE ?? 'refuse';
const SKIP_CHECKS = parseSkipList(process.env.CONVEX_RELEASE_SKIP_CHECKS);
/** Installed next to this file in the images. */
const RUNNER = fileURLToPath(new URL('./predeploy-runner.mjs', import.meta.url));
const POLL_MS = 1000;
/** A read right after `start` can still show the previous run's failure. */
const FAILED_READS = 3;
const UPLOAD_CHUNK = 5 * 1024 * 1024;

interface ReleaseStatus {
  state: 'running' | 'done' | 'failed';
  message?: string;
}

interface Manifest {
  version?: string;
  migrations: string[];
  seeds?: boolean;
  /** By package name; `module` is relative to release.json. */
  checks?: Record<string, { protocol: number; module: string; facts: unknown }>;
}

const log = (message: string) => console.log(`[convex-release] ${message}`);

/** `deploy failed: <first line>`, then every further line of the error with the prefix too. */
function logFailure(err: unknown) {
  const [first, ...rest] = (err instanceof Error ? err.message : String(err)).split('\n');
  log(`deploy failed: ${first}`);
  for (const line of rest) log(line);
}

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

async function call<T>(url: string, key: string, path: string, args: object = {}, endpoint = '/api/function', componentPath?: string): Promise<T> {
  const r = await post<{ status: string; value: T; errorMessage?: string }>(
    url,
    endpoint,
    { path, format: 'json', args, ...(componentPath ? { componentPath } : {}) },
    key,
  );
  if (r.status !== 'success') throw new Error(`${path}: ${r.errorMessage}`);
  return r.value;
}

interface Component {
  id: string;
  path: string;
  state?: string;
}

/** The deployment's components; a component a release removed stays listed as `unmounted`. */
const listComponents = (url: string, key: string) => call<Component[]>(url, key, '_system/frontend/components:list', {}, '/api/query');

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

/**
 * The migrations the deployment has recorded, straight from the component.
 * None when the component isn't deployed yet; any other failure throws, so a
 * broken read never lets an older version through.
 */
async function recordedMigrations(url: string, key: string): Promise<{ name: string; isDone: boolean }[]> {
  const components = await listComponents(url, key);
  if (!components.some((c) => c.path === 'migrations')) return [];
  const r = await post<{ status: string; value: { name: string; isDone: boolean }[]; errorMessage?: string }>(
    url,
    '/api/function',
    { componentPath: 'migrations', path: 'lib:getStatus', format: 'json', args: { limit: 1000 } },
    key,
  );
  if (r.status !== 'success') throw new Error(`reading the recorded migrations failed: ${r.errorMessage}`);
  return r.value;
}

function readManifest(): Manifest | undefined {
  return existsSync(MANIFEST_FILE) ? (JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) as Manifest) : undefined;
}

/**
 * Refuses an older release before anything is pushed: if the data has
 * finished migrations this release doesn't know, a newer one shipped them.
 * With CONVEX_RELEASE_ON_DOWNGRADE=reset, any unknown migration (a preview
 * whose branch renamed or dropped one) wipes the data instead. After a
 * snapshot import, a newer snapshot is deleted again before the error, so the
 * next start imports whatever CONVEX_RELEASE_SNAPSHOT points to by then.
 */
async function checkDowngrade(url: string, key: string, after: 'start' | 'snapshot'): Promise<boolean> {
  const manifest = readManifest();
  if (!manifest) return false;
  const known = new Set(manifest.migrations);
  const unknown = (await recordedMigrations(url, key)).filter((s) => !known.has(s.name));
  if (after === 'start' && ON_DOWNGRADE === 'reset' && unknown.length > 0) {
    log(`the data has migrations this release doesn't (${unknown.map((s) => s.name).join(', ')}); CONVEX_RELEASE_ON_DOWNGRADE=reset: deleting all data`);
    await importZip(url, key, emptyZip(), 'an empty snapshot');
    return true;
  }
  const newer = unknown
    .filter((s) => s.isDone)
    .map((s) => s.name)
    .join(', ');
  if (!newer) return false;
  if (after === 'snapshot') {
    await importZip(url, key, emptyZip(), 'an empty snapshot');
    throw new Error(
      `CONVEX_RELEASE_SNAPSHOT comes from a newer version of the app (migrations not in this one: ${newer}). Export it from this version or an older one.`,
    );
  }
  throw new Error(
    `the data was upgraded by a newer version of the app (migrations not in this one: ${newer}). Run that version or a newer one; nothing was pushed.`,
  );
}

/**
 * Predeploy check queries over the HTTP API, read-only: each target's type is
 * looked up with apiSpec before it's called. `/api/query` would enforce that
 * by itself, but it doesn't call component functions, so calls go through
 * `/api/function`.
 */
function httpTransport(url: string, key: string): PredeployTransport {
  let components: Promise<Component[]> | undefined;
  const specs = new Map<string, Promise<{ identifier: string; functionType: string }[]>>();
  return {
    async query(target, args) {
      const name = target.componentPath ? `${target.componentPath}/${target.path}` : target.path;
      let componentId: string | undefined;
      if (target.componentPath) {
        components ??= listComponents(url, key);
        const component = (await components).find((c) => c.path === target.componentPath && c.state === 'active');
        if (!component) throw new QueryError(`${target.componentPath} isn't deployed`, COMPONENT_NOT_DEPLOYED);
        componentId = component.id;
      }
      const specKey = componentId ?? '';
      if (!specs.has(specKey)) specs.set(specKey, call(url, key, '_system/cli/modules:apiSpec', componentId ? { componentId } : {}, '/api/query'));
      const fn = (await specs.get(specKey)!).find((f) => f.identifier === apiSpecIdentifier(target.path));
      if (!fn) throw new QueryError(`${name} isn't deployed`);
      if (fn.functionType !== 'Query') throw new QueryError(`${name} isn't a query; predeploy checks can only read`);
      try {
        return await call(url, key, target.path, args, '/api/function', target.componentPath);
      } catch (err) {
        throw new QueryError(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

/**
 * Runs the bundled predeploy checks before anything is pushed and throws the
 * refusal if one fails. A misspelled CONVEX_RELEASE_SKIP_CHECKS name is
 * reported even when no check is bundled.
 */
async function predeployChecks(url: string, key: string) {
  const bundled = readManifest()?.checks ?? {};
  const checks: CollectedCheck[] = Object.entries(bundled).map(([packageName, c]) => ({
    packageName,
    modulePath: resolve(dirname(MANIFEST_FILE), c.module),
    protocol: c.protocol,
    facts: c.facts,
  }));
  const { run, skipped, warnings } = applySkips(
    checks.map((c) => c.packageName),
    SKIP_CHECKS,
    'CONVEX_RELEASE_SKIP_CHECKS',
  );
  for (const line of [...skipped.map((o) => o.message!), ...warnings]) log(line);
  const toRun = checks.filter((c) => run.has(c.packageName));
  if (toRun.length === 0) return;
  log(`running ${toRun.length} predeploy check${toRun.length === 1 ? '' : 's'}`);
  const outcomes = await runChecks(toRun, httpTransport(url, key), { runnerPath: RUNNER, log: (pkg, line) => log(`[${pkg}] ${line}`) });
  const refused = refusal(outcomes, 'CONVEX_RELEASE_SKIP_CHECKS=<package>');
  if (refused) throw new Error(refused);
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

/** The release's migrations the deployment hasn't finished. */
async function pendingMigrations(url: string, key: string): Promise<number> {
  const manifest = readManifest();
  if (!manifest) return 0;
  const done = new Set((await recordedMigrations(url, key)).filter((s) => s.isDone).map((s) => s.name));
  return manifest.migrations.filter((name) => !done.has(name)).length;
}

interface SnapshotExport {
  _id: string;
  state: 'requested' | 'in_progress' | 'completed' | 'failed' | 'canceled';
  start_ts?: string;
  size?: string;
  progress_message?: string;
}

/** `convex export --include-file-storage`, over the same HTTP API the CLI uses, as a download stream. */
async function exportZip(url: string, key: string): Promise<ExportStream> {
  const latest = () => call<SnapshotExport | null>(url, key, '_system/cli/exports:getLatest', {}, '/api/query');
  const before = (await latest())?._id;
  await request(url, '/api/export/request/zip?includeStorage=true', key);
  let last = '';
  for (;;) {
    const e = await latest();
    if (e && e._id !== before) {
      if (e.state === 'completed') {
        const res = await fetch(`${url}/api/export/zip/${e.start_ts}`, { headers: { 'Convex-Client': 'convex-release', Authorization: `Convex ${key}` } });
        if (!res.ok || !res.body) throw new Error(`/api/export/zip: HTTP ${res.status}: ${(await res.text()).slice(0, 2000)}`);
        return {
          body: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
          size: e.size === undefined ? undefined : Number(e.size),
        };
      }
      if (e.state === 'failed' || e.state === 'canceled') throw new Error(`the backend's export ${e.state}`);
      const line = e.progress_message ?? '';
      if (line && line !== last) log(`backup: ${(last = line)}`);
    }
    await sleep(POLL_MS);
  }
}

/** The steps of ./apply.ts as HTTP calls to the backend at `url`. */
function httpDeployment(url: string, key: string, settings: Settings): Deployment {
  const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as object;
  return {
    waitUntilUp: () => waitForBackend(url),
    checkDowngrade: (after) => checkDowngrade(url, key, after),
    predeployChecks: () => predeployChecks(url, key),
    pendingMigrations: () => pendingMigrations(url, key),
    isEmpty: () => isEmpty(url, key),
    async getVariable(name) {
      const variable = await call<{ value: string } | null>(url, key, '_system/cli/queryEnvironmentVariables:get', { name }, '/api/query');
      return variable?.value;
    },
    async setVariables(changes) {
      await post(url, '/api/update_environment_variables', { changes: Object.entries(changes).map(([name, value]) => ({ name, value })) }, key);
    },
    exportZip: () => exportZip(url, key),
    push: (kind, label) => push(url, key, read(kind === 'relaxed' ? RELAXED_FILE : PUSH_FILE), label),
    async importSnapshot() {
      const source = settings.snapshot!;
      await importZip(url, key, await readSnapshot(source), source.split('/').at(-1)!);
    },
    migrate: () => runMigrations(url, key),
    seed: () => seed(url, key),
  };
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

function adminKey(mode: Mode): string {
  if (mode.kind === 'combined') return lastLine(execFileSync('./generate_admin_key.sh', { encoding: 'utf8' }));
  // The backend's own credentials derive the admin key, so the release needs
  // nothing beyond what the backend container already has.
  const name = process.env.INSTANCE_NAME;
  const secret = process.env.INSTANCE_SECRET;
  const key =
    process.env.CONVEX_ADMIN_KEY ?? (name && secret ? lastLine(execFileSync('/convex/generate_key', [name, secret], { encoding: 'utf8' })) : undefined);
  if (!key) throw new Error("Set INSTANCE_NAME and INSTANCE_SECRET (the backend's), or CONVEX_ADMIN_KEY.");
  return key;
}

let mode: Mode;
let settings: Settings;
try {
  settings = readSettings(process.env);
  mode = modeFromEnv(process.env, existsSync('./run_backend.sh'));
} catch (err) {
  logFailure(err);
  process.exit(1);
}

let backend: ChildProcess | undefined;
let failed = false;
run(mode, settings, {
  release: { version: readManifest()?.version, relaxed: existsSync(RELAXED_FILE) },
  startBackend() {
    const child = spawn('./run_backend.sh', { stdio: 'inherit' });
    backend = child;
    for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
    child.on('exit', (code, signal) => {
      log(`backend exited (${signal ?? code})`);
      process.exit(failed ? 1 : (code ?? 1));
    });
  },
  removeReady: () => rmSync(READY_FILE, { force: true }),
  writeReady: () => writeFileSync(READY_FILE, new Date().toISOString()),
  adminKey,
  deployment: (url, key) => httpDeployment(url, key, settings),
  runHook,
  log,
  now: () => new Date(),
}).catch((err: unknown) => {
  failed = true;
  logFailure(err);
  if (!backend) process.exit(1);
  backend.kill('SIGINT');
  setTimeout(() => process.exit(1), 10_000).unref();
});
