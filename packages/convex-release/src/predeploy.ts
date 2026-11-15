// Predeploy checks: a dependency of the app declares a check module in its
// package.json (`"convex-release": { "predeploy": "./predeploy.mjs" }`), and
// convex-release runs it against the deployment before anything is pushed.
//
// Each check runs in its own Node process (predeploy-runner), which holds no
// credentials and talks to this host over Node's IPC channel. The host enforces
// the time limit, the protocol and the result shapes, and turns every way a
// check can end into one outcome.
//
// Node built-ins only: the image entrypoint bundles this file.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMPONENT_NOT_DEPLOYED, type PredeployCollectContext } from './predeploy-contract.ts';

export { COMPONENT_NOT_DEPLOYED, type PredeployCheckContext, type PredeployCollectContext, type PredeployResult } from './predeploy-contract.ts';

/** The version of the interface convex-release gives a check module. */
export const PROTOCOL = 1;
/** Each phase of each check gets this long before its runner is killed. */
export const CHECK_TIMEOUT_MS = 600_000;
export const RUNNER_FILE = 'predeploy-runner.mjs';

/** A failed query. `code` is set only when the target component isn't deployed. */
export class QueryError extends Error {
  public readonly code?: typeof COMPONENT_NOT_DEPLOYED;

  public constructor(message: string, code?: typeof COMPONENT_NOT_DEPLOYED) {
    super(message);
    this.code = code;
  }
}

export interface PredeployTransport {
  /** Resolves with the function's value, or rejects with a QueryError. */
  query(target: { componentPath?: string; path: string }, args: object): Promise<unknown>;
}

export type Log = (packageName: string, line: string) => void;
export type Warn = (message: string) => void;
export type SkipSource = '--skip-check' | 'CONVEX_RELEASE_SKIP_CHECKS';

export interface HostOptions {
  runnerPath?: string;
  timeoutMs?: number;
  log: Log;
}

export interface DeclaredCheck {
  packageName: string;
  modulePath: string;
}

export interface CollectedCheck extends DeclaredCheck {
  protocol: number;
  facts: unknown;
}

export interface CheckOutcome {
  packageName: string;
  state: 'passed' | 'failed' | 'skipped';
  message?: string;
  details?: string[];
}

export type Phase = 'load' | 'collect' | 'check';
export type PhaseResult = { ok: true; protocol: number; value: unknown } | { ok: false; message: string };

// ------------------------------------------------------------- discovery ---

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  'convex-release'?: { predeploy?: unknown };
}

/**
 * The checks the app's direct dependencies declare, sorted by package name.
 * Each dependency is looked up as `node_modules/<name>/package.json` from the
 * project root upwards, as Node resolves packages, so a package whose `exports`
 * hides its package.json is still found. Transitive dependencies are never read.
 */
export function discoverChecks(projectRoot: string): DeclaredCheck[] {
  const app = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as PackageJson;
  const names = [...new Set([...Object.keys(app.dependencies ?? {}), ...Object.keys(app.devDependencies ?? {})])];
  const checks: DeclaredCheck[] = [];
  for (const packageName of names) {
    const packageJson = findPackageJson(projectRoot, packageName);
    // Not installed: the package manager's problem, not this one's.
    if (!packageJson) continue;
    const field = (JSON.parse(readFileSync(packageJson, 'utf8')) as PackageJson)['convex-release']?.predeploy;
    if (typeof field !== 'string') continue;
    // Lexical, without realpath: a symlinked package (Bun workspaces, pnpm) stays inside its own folder.
    const packageDir = dirname(packageJson);
    const modulePath = resolve(packageDir, field);
    const inside = relative(packageDir, modulePath);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`${packageName} declares convex-release.predeploy as ${field}, which is outside the package`);
    }
    if (!existsSync(modulePath) || !statSync(modulePath).isFile()) {
      throw new Error(`${packageName} declares convex-release.predeploy as ${field}, which doesn't exist`);
    }
    checks.push({ packageName, modulePath });
  }
  return checks.sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
}

function findPackageJson(from: string, packageName: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', packageName, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

// ----------------------------------------------------------------- skips ---

/**
 * The only place skips are handled. Prints nothing: callers decide where the
 * skipped outcomes' messages and the warnings go. Callers run it even when no
 * check is declared, so a misspelled name is always reported.
 */
export function applySkips(names: string[], skipChecks: string[], source: SkipSource): { run: Set<string>; skipped: CheckOutcome[]; warnings: string[] } {
  const skip = new Set(skipChecks);
  const declared = new Set(names);
  return {
    run: new Set(names.filter((name) => !skip.has(name))),
    skipped: names
      .filter((name) => skip.has(name))
      .map((packageName) => ({ packageName, state: 'skipped' as const, message: `skipped the predeploy check of ${packageName} (${source})` })),
    warnings: [...skip]
      .filter((name) => !declared.has(name))
      .map((name) => `${source} names ${name}, but no dependency declares a predeploy check by that name`),
  };
}

/** `CONVEX_RELEASE_SKIP_CHECKS`: comma-separated package names. */
export function parseSkipList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- runner ---

type RunnerMessage =
  | { type: 'loaded'; protocol?: unknown }
  | { type: 'query'; id: number; target: { componentPath?: string; path: string }; args: object }
  | { type: 'log'; message: string }
  | { type: 'done'; value?: unknown }
  | { type: 'threw'; message: string };

function defaultRunnerPath(): string {
  return fileURLToPath(new URL(`./${RUNNER_FILE}`, import.meta.url));
}

/**
 * Runs one phase of one check in its own runner process. The only function
 * that starts a runner. Resolves once the runner's output streams have closed,
 * so its last lines are logged before its result.
 */
export function runPhase(
  check: DeclaredCheck,
  phase: Phase,
  ctx: object,
  options: HostOptions & { query?: PredeployTransport['query'] },
): Promise<PhaseResult> {
  const runnerPath = resolve(options.runnerPath ?? defaultRunnerPath());
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS;
  const log = (line: string) => options.log(check.packageName, line);
  if (!existsSync(runnerPath)) return Promise.resolve({ ok: false, message: `could not start the runner (no file at ${runnerPath})` });
  // Only the tests run the .ts source; the images' Node needn't support the flag.
  const nodeArgs = runnerPath.endsWith('.ts') ? ['--disable-warning=ExperimentalWarning'] : [];

  return new Promise((done) => {
    let result: PhaseResult | undefined;
    let protocol: number | undefined;
    const child = spawn(process.execPath, [...nodeArgs, runnerPath, check.modulePath], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // No credentials: in the images the only way to the backend is `query`.
      env: { PATH: process.env.PATH ?? '' },
      cwd: dirname(check.modulePath),
    });
    const finish = (outcome: PhaseResult) => {
      if (result) return;
      result = outcome;
      clearTimeout(timer);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => finish({ ok: false, message: `timed out after ${timeoutMs / 1000} seconds` }), timeoutMs);
    const send = (message: object) => {
      // A query that settles after the phase ended has nobody to answer.
      if (result || !child.connected) return;
      try {
        child.send(message);
      } catch {
        // The channel closed in between; the exit decides the outcome.
      }
    };

    const flushers = [child.stdout, child.stderr].map((stream) => forwardLines(stream, log));
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      for (const flush of flushers) flush();
      done(result ?? { ok: false, message: 'exited before finishing (unknown)' });
    };
    child.on('error', (err) => {
      if (protocol === undefined && !result) finish({ ok: false, message: `could not start the runner (${err.message})` });
      // A process that never started emits no 'close'.
      if (child.pid === undefined) settle();
    });
    child.on('exit', (code, signal) => {
      // Our own SIGKILL after a result is expected.
      if (!result) finish({ ok: false, message: `exited before finishing (${code ?? signal})` });
    });
    child.on('close', settle);
    child.on('message', (raw: RunnerMessage) => {
      if (result) return;
      switch (raw?.type) {
        case 'loaded': {
          if (raw.protocol === undefined) return finish({ ok: false, message: "doesn't export a protocol" });
          if (raw.protocol !== PROTOCOL)
            return finish({ ok: false, message: `uses protocol ${JSON.stringify(raw.protocol)}, which this convex-release doesn't support` });
          protocol = PROTOCOL;
          if (phase === 'load') return finish({ ok: true, protocol, value: null });
          return send({ type: 'run', phase, ctx });
        }
        case 'query': {
          const { id, target, args } = raw;
          if (!options.query) return send({ type: 'reply', id, ok: false, error: 'queries are only available in check()' });
          options.query(target, args ?? {}).then(
            (value) => send({ type: 'reply', id, ok: true, value: value ?? null }),
            (err: unknown) =>
              send({
                type: 'reply',
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                code: err instanceof QueryError ? err.code : undefined,
              }),
          );
          return;
        }
        case 'log':
          for (const line of String(raw.message).split('\n')) log(line);
          return;
        case 'done':
          if (protocol === undefined) return finish({ ok: false, message: 'exited before finishing (sent a result before loading)' });
          return finish({ ok: true, protocol, value: raw.value });
        case 'threw':
          return finish({ ok: false, message: String(raw.message) });
        default:
          return finish({ ok: false, message: 'exited before finishing (sent a malformed message)' });
      }
    });
  });
}

/** Calls `log` once per line of `stream`; the returned function logs a trailing partial line. */
function forwardLines(stream: NodeJS.ReadableStream | null, log: (line: string) => void): () => void {
  let pending = '';
  stream?.setEncoding('utf8');
  stream?.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) log(line.replace(/\r$/, ''));
  });
  return () => {
    if (pending) log(pending.replace(/\r$/, ''));
    pending = '';
  };
}

// ---------------------------------------------------------------- phases ---

/** Runs `collect` for each check in order. A failure doesn't stop the rest. */
export async function collectAll(
  checks: DeclaredCheck[],
  ctx: PredeployCollectContext,
  options: HostOptions,
): Promise<{ collected: CollectedCheck[]; failed: CheckOutcome[] }> {
  const collected: CollectedCheck[] = [];
  const failed: CheckOutcome[] = [];
  for (const check of checks) {
    const result = await runPhase(check, 'collect', ctx, options);
    if (result.ok) collected.push({ ...check, protocol: result.protocol, facts: result.value });
    else failed.push({ packageName: check.packageName, state: 'failed', message: result.message });
  }
  return { collected, failed };
}

/** Runs `check` for each check in order, answering its queries through `transport`. */
export async function runChecks(checks: CollectedCheck[], transport: PredeployTransport, options: HostOptions): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    const result = await runPhase(check, 'check', { facts: check.facts }, { ...options, query: (target, args) => transport.query(target, args) });
    outcomes.push(result.ok ? toOutcome(check.packageName, result.value) : { packageName: check.packageName, state: 'failed', message: result.message });
  }
  return outcomes;
}

function toOutcome(packageName: string, value: unknown): CheckOutcome {
  const result = value as { ok?: unknown; message?: unknown; details?: unknown } | null;
  if (result?.ok === true) return { packageName, state: 'passed' };
  const details = result?.details;
  if (
    result?.ok === false &&
    typeof result.message === 'string' &&
    (details === undefined || (Array.isArray(details) && details.every((d) => typeof d === 'string')))
  ) {
    return { packageName, state: 'failed', message: result.message, ...(details ? { details: details as string[] } : {}) };
  }
  return { packageName, state: 'failed', message: 'check() returned something other than { ok: true } or { ok: false, message }' };
}

// --------------------------------------------------------------- results ---

/** The refusal of a release, or undefined when no outcome failed. */
export function refusal(outcomes: CheckOutcome[], skipHint: string): string | undefined {
  const failed = outcomes.filter((o) => o.state === 'failed').sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
  if (failed.length === 0) return undefined;
  return [
    'A predeploy check refused this release; nothing was pushed.',
    ...failed.flatMap((o) => [`${o.packageName}: ${o.message}`, ...(o.details ?? []).map((d) => `  - ${d}`)]),
    `Skip a check with ${skipHint} only if you've confirmed the release is safe.`,
  ].join('\n');
}

/**
 * Proves a check module loads with no `node_modules` above it, as in the
 * images: from a copy in a fresh temp folder.
 */
export async function assertSelfContained(check: DeclaredCheck, options: HostOptions): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'convex-release-check-'));
  try {
    const copy = join(dir, 'check.mjs');
    copyFileSync(check.modulePath, copy);
    const result = await runPhase({ packageName: check.packageName, modulePath: copy }, 'load', {}, options);
    if (!result.ok) {
      throw new Error(
        `${check.packageName}'s predeploy check imports something other than node: built-ins (${result.message}); it has to be a single self-contained file`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ transports ---

/** How `convex run --component` reports a failure, from the outputs recorded against the pinned backend. */
export function classifyCliFailure(output: string): 'unmounted' | 'maybe-missing' | 'function-not-found' | 'other' {
  if (/Could not find function for/.test(output) && /No functions found\./.test(output)) return 'unmounted';
  // A component that was never deployed, or a backend fault: the caller tells them apart.
  if (/InternalServerError/.test(output)) return 'maybe-missing';
  if (/Could not find function|is not a function|Could not find public function/i.test(output)) return 'function-not-found';
  return 'other';
}

/** The `identifier` `_system/cli/modules:apiSpec` lists for a function path: `flags:isBlocked` is `flags.js:isBlocked`. */
export function apiSpecIdentifier(path: string): string {
  const [module, name = 'default'] = path.split(':');
  return `${module}.js:${name}`;
}
