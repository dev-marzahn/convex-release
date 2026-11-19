// Bundles examples/basic for real with its installed `convex` CLI. Offline:
// --write-push-request stops before contacting any server.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vite-plus/test';

import { assertImageVersion, bundle, bundleChecks } from '../src/bundle.ts';
import { findProject } from '../src/project.ts';

const example = fileURLToPath(new URL('../../../examples/basic', import.meta.url));

interface Module {
  path: string;
  source: string;
}
type Request = { adminKey?: string; appDefinition: { schema: Module; changedModules: Module[] } };

test('writes a strict and a validation-off push request that differ only in the schema', { timeout: 60_000 }, async () => {
  const out = mkdtempSync(join(tmpdir(), 'convex-release-bundle-'));
  const result = await bundle(findProject(example), out);
  expect(result).toMatchObject({ migrations: 3, relaxed: true, checks: 0 });

  const strict = JSON.parse(readFileSync(join(out, 'push.json'), 'utf8')) as Request;
  const relaxed = JSON.parse(readFileSync(join(out, 'push.relaxed.json'), 'utf8')) as Request;
  expect(strict.adminKey).toBeUndefined();
  expect(strict.appDefinition.changedModules.map((m) => m.path)).toEqual(
    expect.arrayContaining(['migrations/0001_rename_body_to_text.js', 'migrations/_generated.js', 'messages.js']),
  );
  expect(strict.appDefinition.schema.source).not.toContain('schemaValidation = !1');
  expect(relaxed.appDefinition.schema.source).toContain('schemaValidation = !1');
  // The seeds wiring imports the schema, so a separately bundled relaxed copy
  // would differ here; pass 1 has to run pass 2's code exactly.
  expect(strict.appDefinition.changedModules.map((m) => m.path)).toContain('seeds/_generated.js');
  expect(relaxed.appDefinition.changedModules).toEqual(strict.appDefinition.changedModules);

  const manifest = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')) as { version?: string; migrations: string[]; seeds: boolean };
  expect(manifest).toEqual({
    // The app's package.json version, which the images record on the deployment.
    version: '1.0.0',
    migrations: ['migrations/0001_rename_body_to_text', 'migrations/0002_add_length', 'migrations/0003_author_to_users'],
    seeds: true,
  });
});

describe('bundleChecks', () => {
  const runnerPath = fileURLToPath(new URL('../src/predeploy-runner.ts', import.meta.url));
  const quiet = { runnerPath, log: () => {} };

  /** An app depending on `@scope/lib`, whose predeploy module is `source`. */
  function app(source: string, extra: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'convex-release-bundle-checks-'));
    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    write('package.json', JSON.stringify({ name: 'the-app', dependencies: { '@scope/lib': '1' } }));
    write('node_modules/@scope/lib/package.json', JSON.stringify({ name: '@scope/lib', 'convex-release': { predeploy: './check.mjs' } }));
    write('node_modules/@scope/lib/check.mjs', source);
    for (const [path, content] of Object.entries(extra)) write(path, content);
    return findProject(root);
  }

  test('copies each module into checks/ and returns its facts', async () => {
    const source =
      'import { readFileSync } from "node:fs"; export const protocol = 1; export function collect({ projectRoot }) { return JSON.parse(readFileSync(projectRoot + "/package.json", "utf8")).name; }';
    const project = app(source);
    const out = mkdtempSync(join(tmpdir(), 'convex-release-bundle-out-'));
    mkdirSync(join(out, 'checks'));
    writeFileSync(join(out, 'checks/stale.mjs'), '');
    expect(await bundleChecks(project, out, quiet)).toEqual({ '@scope/lib': { protocol: 1, module: 'checks/@scope__lib.mjs', facts: 'the-app' } });
    expect(readFileSync(join(out, 'checks/@scope__lib.mjs'), 'utf8')).toBe(source);
    expect(readdirSync(join(out, 'checks'))).toEqual(['@scope__lib.mjs']);
  });

  test('a failing collect fails the bundle, naming the package', async () => {
    const project = app('export const protocol = 1; export function collect() { throw new Error("cannot read the workflows"); }');
    await expect(bundleChecks(project, mkdtempSync(join(tmpdir(), 'convex-release-bundle-out-')), quiet)).rejects.toThrow(
      'Predeploy check collect failed:\n@scope/lib: cannot read the workflows',
    );
  });

  test('a module that imports a package fails the self-contained proof', async () => {
    // left-pad is installed, so collect succeeds; only the copy without node_modules fails.
    const project = app('import pad from "left-pad"; export const protocol = 1; export function collect() { return pad; }', {
      'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', type: 'module', exports: './index.js' }),
      'node_modules/left-pad/index.js': 'export default 1;',
    });
    await expect(bundleChecks(project, mkdtempSync(join(tmpdir(), 'convex-release-bundle-out-')), quiet)).rejects.toThrow(
      /^@scope\/lib's predeploy check imports something other than node: built-ins \(.*left-pad.*\); it has to be a single self-contained file$/s,
    );
  });
});

test('refuses to bundle in an image of another convex-release version', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'convex-release-image-')), 'release-package.json');
  writeFileSync(file, JSON.stringify({ version: '0.2.0' }));
  expect(() => assertImageVersion('0.1.0', file)).toThrow('This image is convex-release 0.2.0, but the app has 0.1.0 installed');
  expect(() => assertImageVersion('0.2.0', file)).not.toThrow();
  expect(() => assertImageVersion('0.1.0', join(tmpdir(), 'missing.json'))).not.toThrow();
});
