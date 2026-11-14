// Bundles examples/basic for real with its installed `convex` CLI. Offline:
// --write-push-request stops before contacting any server.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { assertImageVersion, bundle } from '../src/bundle.ts';
import { findProject } from '../src/project.ts';

const example = fileURLToPath(new URL('../../../examples/basic', import.meta.url));

interface Module {
  path: string;
  source: string;
}
type Request = { adminKey?: string; appDefinition: { schema: Module; changedModules: Module[] } };

test('writes a strict and a validation-off push request that differ only in the schema', { timeout: 60_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'convex-release-bundle-'));
  const result = bundle(findProject(example), out);
  expect(result).toMatchObject({ migrations: 3, relaxed: true });

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

  const manifest = JSON.parse(readFileSync(join(out, 'release.json'), 'utf8')) as { migrations: string[]; seeds: boolean };
  expect(manifest).toEqual({
    migrations: ['migrations/0001_rename_body_to_text', 'migrations/0002_add_length', 'migrations/0003_author_to_users'],
    seeds: true,
  });
});

test('refuses to bundle in an image of another convex-release version', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'convex-release-image-')), 'release-package.json');
  writeFileSync(file, JSON.stringify({ version: '0.2.0' }));
  expect(() => assertImageVersion('0.1.0', file)).toThrow('This image is convex-release 0.2.0, but the app has 0.1.0 installed');
  expect(() => assertImageVersion('0.2.0', file)).not.toThrow();
  expect(() => assertImageVersion('0.1.0', join(tmpdir(), 'missing.json'))).not.toThrow();
});
