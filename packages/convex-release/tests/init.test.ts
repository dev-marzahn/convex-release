import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vite-plus/test';

import { detectPackageManager, ensureConvexConfig, missingPackages } from '../src/init.ts';
import { findProject } from '../src/project.ts';

function dir(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'convex-release-init-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('detectPackageManager', () => {
  test('the lockfile decides', () => {
    expect(detectPackageManager(dir({ 'bun.lock': '' }))).toBe('bun');
    expect(detectPackageManager(dir({ 'pnpm-lock.yaml': '' }))).toBe('pnpm');
    expect(detectPackageManager(dir({ 'package-lock.json': '' }), 'bun/1.4.4')).toBe('npm');
  });

  test('without a lockfile, the package manager running the command', () => {
    expect(detectPackageManager(dir(), 'bun/1.4.4 npm/? node/v26')).toBe('bun');
    expect(detectPackageManager(dir(), '')).toBe('npm');
  });
});

describe('missingPackages', () => {
  test('lists what package.json lacks', () => {
    const root = dir({ 'package.json': JSON.stringify({ devDependencies: { '@convex-dev/migrations': '^0.3.8' } }) });
    expect(missingPackages(root)).toEqual(['@dev-marzahn/convex-release']);
  });

  test("adds convex-helpers for Yarn, which doesn't install peer dependencies", () => {
    const root = dir({ 'package.json': JSON.stringify({ dependencies: { '@convex-dev/migrations': '^0.3.8', '@dev-marzahn/convex-release': '^0.1.0' } }) });
    expect(missingPackages(root, 'yarn')).toEqual(['convex-helpers']);
    expect(missingPackages(root, 'pnpm')).toEqual([]);
  });
});

describe('ensureConvexConfig', () => {
  test('creates convex.config.ts when there is none', () => {
    const project = findProject(dir({ 'convex/schema.ts': '' }));
    expect(ensureConvexConfig(project)).toBe('created');
    expect(readFileSync(join(project.functionsDir, 'convex.config.ts'), 'utf8')).toContain('app.use(migrations);');
  });

  test('adds the component to an existing config and leaves the rest', () => {
    const source =
      'import { defineApp } from "convex/server";\nimport agent from "@convex-dev/agent/convex.config";\n\nconst app = defineApp();\napp.use(agent);\nexport default app;\n';
    const project = findProject(dir({ 'convex/convex.config.ts': source }));
    expect(ensureConvexConfig(project)).toBe('updated');
    const updated = readFileSync(join(project.functionsDir, 'convex.config.ts'), 'utf8');
    expect(updated).toContain('import migrations from "@convex-dev/migrations/convex.config";');
    expect(updated).toContain('const app = defineApp();\napp.use(migrations);\napp.use(agent);');
    expect(ensureConvexConfig(project)).toBe('unchanged');
  });

  test('asks for a manual edit when it cannot find defineApp()', () => {
    const project = findProject(dir({ 'convex/convex.config.ts': 'export { default } from "./app.config";\n' }));
    expect(ensureConvexConfig(project)).toBe('manual');
  });
});
