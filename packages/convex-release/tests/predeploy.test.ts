// Predeploy checks with real runner processes: the runner's TypeScript source
// runs directly, check modules are written to temp folders.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vite-plus/test';

import {
  apiSpecIdentifier,
  applySkips,
  assertSelfContained,
  classifyCliFailure,
  collectAll,
  COMPONENT_NOT_DEPLOYED,
  discoverChecks,
  parseSkipList,
  QueryError,
  refusal,
  runChecks,
  runPhase,
  type CheckOutcome,
  type PredeployTransport,
} from '../src/predeploy.ts';

const runnerPath = fileURLToPath(new URL('../src/predeploy-runner.ts', import.meta.url));

const temp = (prefix = 'convex-release-predeploy-') => mkdtempSync(join(tmpdir(), prefix));

function write(path: string, content: string | object) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
}

/** A check module in its own temp folder. */
function checkModule(source: string, packageName = 'lib') {
  const modulePath = join(temp(), 'check.mjs');
  write(modulePath, source);
  return { packageName, modulePath };
}

function logger() {
  const lines: [string, string][] = [];
  return { lines, log: (packageName: string, line: string) => lines.push([packageName, line]) };
}

const options = (extra: object = {}) => ({ runnerPath, log: () => {}, ...extra });
const noQueries: PredeployTransport = { query: () => Promise.reject(new Error('no queries expected')) };

describe('discoverChecks', () => {
  /** An app at <root>/<app> whose node_modules may sit in a parent folder. */
  function project(deps: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }, appDir = '.') {
    const root = temp();
    const app = join(root, appDir);
    write(join(app, 'package.json'), { name: 'app', ...deps });
    return { root, app };
  }
  function library(nodeModules: string, name: string, pkg: object, files: Record<string, string> = { 'predeploy.mjs': '' }) {
    write(join(nodeModules, name, 'package.json'), { name, ...pkg });
    for (const [file, content] of Object.entries(files)) write(join(nodeModules, name, file), content);
  }
  const declares = { 'convex-release': { predeploy: './predeploy.mjs' } };

  test('finds dependencies and devDependencies that declare a check, sorted', () => {
    const { app } = project({ dependencies: { zeta: '1', plain: '1' }, devDependencies: { '@scope/alpha': '1' } });
    library(join(app, 'node_modules'), 'zeta', declares);
    library(join(app, 'node_modules'), '@scope/alpha', declares);
    library(join(app, 'node_modules'), 'plain', {});
    expect(discoverChecks(app)).toEqual([
      { packageName: '@scope/alpha', modulePath: join(app, 'node_modules/@scope/alpha/predeploy.mjs') },
      { packageName: 'zeta', modulePath: join(app, 'node_modules/zeta/predeploy.mjs') },
    ]);
  });

  test('ignores transitive dependencies, and skips ones that are not installed', () => {
    const { app } = project({ dependencies: { direct: '1', missing: '1' } });
    library(join(app, 'node_modules'), 'direct', { dependencies: { transitive: '1' } });
    library(join(app, 'node_modules'), 'transitive', declares);
    expect(discoverChecks(app)).toEqual([]);
  });

  test("finds a package whose exports don't list package.json, and one hoisted to a parent node_modules", () => {
    const { root, app } = project({ dependencies: { hidden: '1', hoisted: '1' } }, 'apps/web');
    library(join(app, 'node_modules'), 'hidden', { ...declares, exports: { '.': './index.js' } });
    library(join(root, 'node_modules'), 'hoisted', declares);
    expect(discoverChecks(app).map((c) => c.packageName)).toEqual(['hidden', 'hoisted']);
  });

  test('accepts a package reached through a symlinked node_modules entry', () => {
    const { app } = project({ dependencies: { linked: '1' } });
    const real = join(temp(), 'linked');
    write(join(real, 'package.json'), { name: 'linked', ...declares });
    write(join(real, 'predeploy.mjs'), '');
    mkdirSync(join(app, 'node_modules'), { recursive: true });
    symlinkSync(real, join(app, 'node_modules/linked'));
    expect(discoverChecks(app)).toEqual([{ packageName: 'linked', modulePath: join(app, 'node_modules/linked/predeploy.mjs') }]);
  });

  test('a module path outside the package, or one that does not exist, is an error naming the package', () => {
    const outside = project({ dependencies: { sneaky: '1' } });
    library(join(outside.app, 'node_modules'), 'sneaky', { 'convex-release': { predeploy: '../other/check.mjs' } });
    expect(() => discoverChecks(outside.app)).toThrow('sneaky declares convex-release.predeploy as ../other/check.mjs, which is outside the package');

    const missing = project({ dependencies: { broken: '1' } });
    library(join(missing.app, 'node_modules'), 'broken', { 'convex-release': { predeploy: './gone.mjs' } }, {});
    expect(() => discoverChecks(missing.app)).toThrow("broken declares convex-release.predeploy as ./gone.mjs, which doesn't exist");
  });
});

describe('runPhase', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('collect returns facts; nothing becomes null', async () => {
    const facts = checkModule('export const protocol = 1; export async function collect(ctx) { return { root: ctx.projectRoot }; }');
    expect(await runPhase(facts, 'collect', { projectRoot: '/app', convexDir: '/app/convex' }, options())).toEqual({
      ok: true,
      protocol: 1,
      value: { root: '/app' },
    });
    const none = checkModule('export const protocol = 1; export function collect() {}');
    expect(await runPhase(none, 'collect', {}, options())).toEqual({ ok: true, protocol: 1, value: null });
  });

  test.each([
    ['a bare function', '() => 1'],
    ['a Date', 'new Date(0)'],
    ['a BigInt', '1n'],
    ['a circular object', '(() => { const o = {}; o.self = o; return o; })()'],
  ])('facts that are %s are refused', async (_, value) => {
    const check = checkModule(`export const protocol = 1; export function collect() { return ${value}; }`);
    expect(await runPhase(check, 'collect', {}, options())).toEqual({ ok: false, message: "collect() returned a value that isn't plain JSON" });
  });

  test('check gets the facts and returns its result', async () => {
    const check = checkModule('export const protocol = 1; export function check({ facts }) { return { ok: false, message: facts.why, details: ["a", "b"] }; }');
    expect(await runPhase(check, 'check', { facts: { why: 'no' } }, options())).toEqual({
      ok: true,
      protocol: 1,
      value: { ok: false, message: 'no', details: ['a', 'b'] },
    });
  });

  test.each([
    ['throws from check', 'export const protocol = 1; export function check() { throw new Error("boom"); }', 'boom'],
    ['throws while it is imported', 'throw new Error("boom at import");', 'boom at import'],
    ['calls process.exit(3)', 'export const protocol = 1; export function check() { process.exit(3); }', 'exited before finishing (3)'],
    [
      'uses protocol 2',
      'export const protocol = 2; export function check() { throw new Error("ran"); }',
      "uses protocol 2, which this convex-release doesn't support",
    ],
    ['exports no protocol', 'export function check() { throw new Error("ran"); }', "doesn't export a protocol"],
  ])('a module that %s fails', async (_, source, message) => {
    const result = await runPhase(checkModule(source, 'some-library'), 'check', { facts: null }, options());
    expect(result).toEqual({ ok: false, message });
    expect(JSON.stringify(result)).not.toContain('some-library');
  });

  test.each([
    ['a check that never resolves', 'export const protocol = 1; export function check() { return new Promise(() => {}); }'],
    ['a loop that never yields', 'export const protocol = 1; export function check() { for (;;) {} }'],
    ['a module that awaits forever while imported', 'await new Promise(() => {}); export const protocol = 1;'],
  ])('%s times out', async (_, source) => {
    expect(await runPhase(checkModule(source), 'check', { facts: null }, options({ timeoutMs: 200 }))).toEqual({
      ok: false,
      message: 'timed out after 0.2 seconds',
    });
  });

  test('a runner that does not exist cannot start', async () => {
    const result = await runPhase(checkModule('export const protocol = 1;'), 'load', {}, options({ runnerPath: '/nowhere/runner.mjs' }));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/^could not start the runner \(/) });
  });

  test('the runner has PATH and no credentials', async () => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', 'prod:secret');
    const check = checkModule(
      'export const protocol = 1; export function check() { return { ok: false, message: JSON.stringify({ path: Boolean(process.env.PATH), convex: Object.keys(process.env).filter((k) => k.startsWith("CONVEX_")) }) }; }',
    );
    const result = await runPhase(check, 'check', { facts: null }, options());
    expect(result.ok && JSON.parse((result.value as { message: string }).message)).toEqual({ path: true, convex: [] });
  });

  test('stdout, stderr and ctx.log lines reach log with the package name, the last one before the result', async () => {
    const { lines, log } = logger();
    const check = checkModule(
      'export const protocol = 1; export function check({ log }) { console.error("to stderr"); log("one\\ntwo"); process.stdout.write("last, no newline"); return { ok: true }; }',
      'chatty',
    );
    const result = await runPhase(check, 'check', { facts: null }, options({ log }));
    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(lines.map(([pkg]) => pkg).every((pkg) => pkg === 'chatty')).toBe(true);
    expect(lines.map(([, line]) => line).sort()).toEqual(['last, no newline', 'one', 'to stderr', 'two']);
  });
});

describe('runChecks', () => {
  const blocking = (name: string, message: string) => ({
    ...checkModule(`export const protocol = 1; export function check() { return { ok: false, message: ${JSON.stringify(message)} }; }`, name),
    protocol: 1,
    facts: null,
  });

  test('runs every check in order, and a failure does not stop the rest', async () => {
    const order: string[] = [];
    const passing = {
      ...checkModule('export const protocol = 1; export function check({ log }) { log("ran"); return { ok: true }; }', 'b'),
      protocol: 1,
      facts: null,
    };
    const outcomes = await runChecks([blocking('a', 'first'), passing, blocking('c', 'third')], noQueries, options({ log: (pkg: string) => order.push(pkg) }));
    expect(outcomes).toEqual([
      { packageName: 'a', state: 'failed', message: 'first' },
      { packageName: 'b', state: 'passed' },
      { packageName: 'c', state: 'failed', message: 'third' },
    ]);
    expect(order).toEqual(['b']);
  });

  test('a malformed result fails', async () => {
    const check = { ...checkModule('export const protocol = 1; export function check() { return { ok: "yes" }; }'), protocol: 1, facts: null };
    expect(await runChecks([check], noQueries, options())).toEqual([
      { packageName: 'lib', state: 'failed', message: 'check() returned something other than { ok: true } or { ok: false, message }' },
    ]);
  });

  test('queries go through the transport, and a rejection the module does not catch fails the check', async () => {
    const calls: unknown[] = [];
    const transport: PredeployTransport = {
      query: async (target, args) => {
        calls.push([target, args]);
        if (target.path === 'lib:broken') throw new QueryError('lib:broken: Server Error');
        return 'blocked';
      },
    };
    const asks = {
      ...checkModule(
        'export const protocol = 1; export async function check({ query }) { const r = await query({ componentPath: "c", path: "lib:status" }); await query({ path: "lib:broken" }, { x: 1 }); return { ok: true, r }; }',
      ),
      protocol: 1,
      facts: null,
    };
    expect(await runChecks([asks], transport, options())).toEqual([{ packageName: 'lib', state: 'failed', message: 'lib:broken: Server Error' }]);
    expect(calls).toEqual([
      [{ componentPath: 'c', path: 'lib:status' }, {}],
      [{ path: 'lib:broken' }, { x: 1 }],
    ]);
  });

  test('COMPONENT_NOT_DEPLOYED reaches the module with its code, so the module can pass', async () => {
    const transport: PredeployTransport = { query: () => Promise.reject(new QueryError("c isn't deployed", COMPONENT_NOT_DEPLOYED)) };
    const check = {
      ...checkModule(
        'export const protocol = 1; export async function check({ query }) { try { await query({ componentPath: "c", path: "lib:x" }); } catch (e) { if (e.code === "COMPONENT_NOT_DEPLOYED" && e.message === "c isn\'t deployed") return { ok: true }; throw e; } return { ok: false, message: "resolved" }; }',
      ),
      protocol: 1,
      facts: null,
    };
    expect(await runChecks([check], transport, options())).toEqual([{ packageName: 'lib', state: 'passed' }]);
  });

  test('a query still in flight when the time limit kills the runner settles without an error', async () => {
    let settled = false;
    const transport: PredeployTransport = {
      query: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve('late');
          }, 400),
        ),
    };
    const check = {
      ...checkModule('export const protocol = 1; export function check({ query }) { return query({ path: "a:b" }); }'),
      protocol: 1,
      facts: null,
    };
    expect(await runChecks([check], transport, options({ timeoutMs: 200 }))).toEqual([
      { packageName: 'lib', state: 'failed', message: 'timed out after 0.2 seconds' },
    ]);
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(true);
  });
});

test('collectAll collects facts and records failures without stopping', async () => {
  const good = checkModule('export const protocol = 1; export function collect() { return { n: 1 }; }', 'good');
  const bad = checkModule('export const protocol = 1; export function collect() { throw new Error("no facts"); }', 'bad');
  expect(await collectAll([bad, good], { projectRoot: '/app', convexDir: '/app/convex' }, options())).toEqual({
    collected: [{ ...good, protocol: 1, facts: { n: 1 } }],
    failed: [{ packageName: 'bad', state: 'failed', message: 'no facts' }],
  });
});

describe('applySkips', () => {
  test('skips declared names, keeps the order of the rest, and warns about undeclared ones', () => {
    expect(applySkips(['a', 'b', 'c'], ['b', 'typo'], '--skip-check')).toEqual({
      run: new Set(['a', 'c']),
      skipped: [{ packageName: 'b', state: 'skipped', message: 'skipped the predeploy check of b (--skip-check)' }],
      warnings: ['--skip-check names typo, but no dependency declares a predeploy check by that name'],
    });
    expect([...applySkips(['c', 'a'], [], '--skip-check').run]).toEqual(['c', 'a']);
  });

  test('warns even when nothing is declared', () => {
    expect(applySkips([], ['lib'], 'CONVEX_RELEASE_SKIP_CHECKS').warnings).toEqual([
      'CONVEX_RELEASE_SKIP_CHECKS names lib, but no dependency declares a predeploy check by that name',
    ]);
  });
});

describe('refusal', () => {
  const failed = (packageName: string, message: string, details?: string[]): CheckOutcome => ({
    packageName,
    state: 'failed',
    message,
    ...(details ? { details } : {}),
  });

  test('lists each failure with its details, in package-name order', () => {
    expect(refusal([failed('zeta', 'second'), { packageName: 'mid', state: 'passed' }, failed('alpha', 'first', ['x', 'y'])], '--skip-check <package>')).toBe(
      [
        'A predeploy check refused this release; nothing was pushed.',
        'alpha: first',
        '  - x',
        '  - y',
        'zeta: second',
        "Skip a check with --skip-check <package> only if you've confirmed the release is safe.",
      ].join('\n'),
    );
  });

  test('is undefined when nothing failed', () => {
    expect(
      refusal(
        [
          { packageName: 'a', state: 'passed' },
          { packageName: 'b', state: 'skipped' },
        ],
        '--skip-check <package>',
      ),
    ).toBeUndefined();
  });
});

test('parseSkipList', () => {
  expect(parseSkipList(undefined)).toEqual([]);
  expect(parseSkipList('')).toEqual([]);
  expect(parseSkipList(' a, ,b ')).toEqual(['a', 'b']);
});

describe('assertSelfContained', () => {
  test('passes for a module with only node: imports', async () => {
    await expect(assertSelfContained(checkModule('import { join } from "node:path"; export const protocol = 1;'), options())).resolves.toBeUndefined();
  });

  test('fails with the package named for a module that imports a package', async () => {
    await expect(assertSelfContained(checkModule('import pad from "left-pad"; export const protocol = 1;', 'needy'), options())).rejects.toThrow(
      /^needy's predeploy check imports something other than node: built-ins \(.*left-pad.*\); it has to be a single self-contained file$/s,
    );
  });
});

// The outputs `convex run --component` printed against the pinned backend.
test.each([
  [
    "✖ Failed to run function \"flags:isBlocked\":\nError: [Request ID: 0957] Server Error\nCould not find function for 'flags:isBlocked' in 'predeployFixture'. Did you forget to run `npx convex dev`?\n\nNo functions found.",
    'unmounted',
  ],
  [
    '✖ Failed to run function "flags:isBlocked":\nError: {"code":"InternalServerError","message":"Your request couldn\'t be completed. Try again later."}',
    'maybe-missing',
  ],
  [
    "✖ Failed to run function \"flags:nope\":\nError: Server Error\nCould not find function for 'flags:nope' in 'predeployFixture'.\n\nAvailable functions:\n• flags:isBlocked",
    'function-not-found',
  ],
  ['✖ Failed to run function "flags:isBlocked":\nError: Server Error\nUncaught Error: expected 5 migrated messages', 'other'],
] as const)('classifyCliFailure(%#)', (output, kind) => {
  expect(classifyCliFailure(output)).toBe(kind);
});

test('apiSpecIdentifier', () => {
  expect(apiSpecIdentifier('flags:isBlocked')).toBe('flags.js:isBlocked');
  expect(apiSpecIdentifier('dir/mod:fn')).toBe('dir/mod.js:fn');
  expect(apiSpecIdentifier('mod')).toBe('mod.js:default');
});
