import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

import { findProject } from '../src/project.ts';
import { copyProject } from '../src/relaxed.ts';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'convex-release-copy-'));
  for (const [path, content] of Object.entries({
    'package.json': '{}',
    '.env.local': 'CONVEX_DEPLOYMENT=dev:x',
    'convex/schema.ts': 'export default defineSchema({});\n',
    'convex/messages.ts': 'export const x = 1;\n',
    'node_modules/convex/package.json': '{}',
    '.convex/local/state.json': '{}',
    '.git/HEAD': 'ref',
    'dist/out.js': '',
  })) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return findProject(root);
}

test('copies the source, shares node_modules and .convex, skips .git and dist', () => {
  const copy = copyProject(project());
  try {
    const root = copy.project.root;
    expect(readFileSync(join(root, 'convex/messages.ts'), 'utf8')).toBe('export const x = 1;\n');
    expect(existsSync(join(root, '.env.local'))).toBe(true);
    expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(root, '.convex')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, '.git'))).toBe(false);
    expect(existsSync(join(root, 'dist'))).toBe(false);
  } finally {
    copy.dispose();
  }
});

test('relaxSchema wraps the real schema with validation off', () => {
  const original = project();
  const copy = copyProject(original);
  try {
    copy.relaxSchema();
    const dir = copy.project.functionsDir;
    expect(readFileSync(join(dir, 'schema.strict.ts'), 'utf8')).toBe('export default defineSchema({});\n');
    expect(readFileSync(join(dir, 'schema.ts'), 'utf8')).toContain('schemaValidation = false');
    // The original project is untouched.
    expect(readFileSync(join(original.functionsDir, 'schema.ts'), 'utf8')).toBe('export default defineSchema({});\n');
  } finally {
    copy.dispose();
  }
  expect(existsSync(copy.project.root)).toBe(false);
});
