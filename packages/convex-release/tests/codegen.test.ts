import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vite-plus/test';

import { listMigrations, listSeeds, MigrationFileError, renderGenerated, renderSeedsGenerated, writeGenerated } from '../src/codegen.ts';
import { findProject } from '../src/project.ts';

function project(files: Record<string, string>, convexJson?: object) {
  const root = mkdtempSync(join(tmpdir(), 'convex-release-'));
  if (convexJson) writeFileSync(join(root, 'convex.json'), JSON.stringify(convexJson));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return findProject(root);
}

describe('listMigrations', () => {
  test('orders by number, not by name', () => {
    const p = project({
      'convex/migrations/10_last.ts': '',
      'convex/migrations/2_second.ts': '',
      'convex/migrations/0001_first.ts': '',
    });
    expect(listMigrations(p.migrationsDir).map((m) => m.module)).toEqual(['0001_first', '2_second', '10_last']);
  });

  test('ignores the generated file, helpers starting with _, tests and declarations', () => {
    const p = project({
      'convex/migrations/_generated.ts': '',
      'convex/migrations/_helpers.ts': '',
      'convex/migrations/0001_a.test.ts': '',
      'convex/migrations/0001_a.ts': '',
    });
    expect(listMigrations(p.migrationsDir).map((m) => m.file)).toEqual(['0001_a.ts']);
  });

  test("rejects files that aren't named like migrations", () => {
    const p = project({ 'convex/migrations/renameBody.ts': '' });
    expect(() => listMigrations(p.migrationsDir)).toThrow(MigrationFileError);
  });

  test('rejects two migrations with the same number', () => {
    const p = project({ 'convex/migrations/0002_a.ts': '', 'convex/migrations/2_b.ts': '' });
    expect(() => listMigrations(p.migrationsDir)).toThrow(/same number/);
  });

  test('no migrations folder means no migrations', () => {
    expect(listMigrations(project({}).migrationsDir)).toEqual([]);
  });

  test("follows convex.json's functions path", () => {
    const p = project({ 'backend/convex/migrations/0001_a.ts': '' }, { functions: 'backend/convex/' });
    expect(p.functionsPath).toBe('backend/convex');
    expect(listMigrations(p.migrationsDir).map((m) => m.module)).toEqual(['0001_a']);
  });
});

describe('renderGenerated', () => {
  test('lists the migrations in order as function references', () => {
    const out = renderGenerated([
      { number: 1, module: '0001_rename_body', file: '0001_rename_body.ts' },
      { number: 2, module: '0002_add_length', file: '0002_add_length.ts' },
    ]);
    expect(out).toContain('release.upgrade([\n  internal.migrations["0001_rename_body"].default,\n  internal.migrations["0002_add_length"].default,\n])');
  });

  test('with no migrations, still exports start and status', () => {
    expect(renderGenerated([])).toContain('release.upgrade([])');
  });
});

describe('writeGenerated', () => {
  test('writes once, then reports no change', () => {
    const p = project({ 'convex/migrations/0001_a.ts': '' });
    expect(writeGenerated(p).changed).toBe(true);
    expect(writeGenerated(p).changed).toBe(false);
    expect(readFileSync(join(p.migrationsDir, '_generated.ts'), 'utf8')).toContain('internal.migrations["0001_a"]');
  });

  test('writes the seeds file only when there is a seeds folder', () => {
    const p = project({ 'convex/migrations/0001_a.ts': '' });
    expect(writeGenerated(p).seeds).toBeNull();
    expect(existsSync(join(p.seedsDir, '_generated.ts'))).toBe(false);

    mkdirSync(p.seedsDir);
    writeFileSync(join(p.seedsDir, '01_users.ts'), '');
    expect(writeGenerated(p)).toMatchObject({ changed: true, seeds: ['01_users'] });
    expect(readFileSync(join(p.seedsDir, '_generated.ts'), 'utf8')).toContain('internal.seeds["01_users"]');
  });
});

describe('listSeeds', () => {
  test('orders by number prefix, then by name', () => {
    const p = project({
      'convex/seeds/10_comments.ts': '',
      'convex/seeds/2_messages.ts': '',
      'convex/seeds/01_users.ts': '',
      'convex/seeds/extra.ts': '',
      'convex/seeds/demo.ts': '',
    });
    expect(listSeeds(p.seedsDir)).toEqual(['01_users', '2_messages', '10_comments', 'demo', 'extra']);
  });

  test('ignores the generated file, helpers, tests and declarations', () => {
    const p = project({
      'convex/seeds/_generated.ts': '',
      'convex/seeds/_fake.ts': '',
      'convex/seeds/users.test.ts': '',
      'convex/seeds/users.ts': '',
    });
    expect(listSeeds(p.seedsDir)).toEqual(['users']);
  });

  test("rejects names Convex can't use as a module", () => {
    const p = project({ 'convex/seeds/my seed.ts': '' });
    expect(() => listSeeds(p.seedsDir)).toThrow(MigrationFileError);
  });
});

describe('renderSeedsGenerated', () => {
  test('lists the seeds in order and imports the schema for the empty check', () => {
    const out = renderSeedsGenerated(['01_users', '02_messages']);
    expect(out).toContain('seeds.runner([\n  internal.seeds["01_users"].default,\n  internal.seeds["02_messages"].default,\n])');
    expect(out).toContain('import schema from "../schema";');
    expect(out).toContain('from "@dev-marzahn/convex-release/seed"');
  });
});
