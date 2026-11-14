// Bundles examples/basic for real with its installed `convex` CLI. Offline:
// --write-push-request stops before contacting any server.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { bundle } from '../src/bundle.ts';
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
  expect(relaxed.appDefinition.changedModules).toEqual(strict.appDefinition.changedModules);
});
