import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, test } from 'vite-plus/test';

import { createMigration, createSeed, migrationSlug } from '../src/new.ts';
import { findProject } from '../src/project.ts';

describe('migrationSlug', () => {
  test.each([
    ['rename body to text', 'rename_body_to_text'],
    ['  Rename Body -> Text!  ', 'rename_body_text'],
    ['renameBodyToText', 'rename_body_to_text'],
    ['add 2nd index', 'add_2nd_index'],
  ])('%s -> %s', (name, slug) => {
    expect(migrationSlug(name)).toBe(slug);
  });

  test('rejects names without letters or digits', () => {
    expect(() => migrationSlug('!!!')).toThrow();
  });
});

describe('createMigration', () => {
  test('numbers after the highest existing migration', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-release-new-'));
    mkdirSync(join(root, 'convex/migrations'), { recursive: true });
    writeFileSync(join(root, 'convex/migrations/0001_a.ts'), '');
    writeFileSync(join(root, 'convex/migrations/0007_b.ts'), '');
    const path = createMigration(findProject(root), 'add length', 'messages');
    expect(basename(path)).toBe('0008_add_length.ts');
    expect(readFileSync(path, 'utf8')).toContain('table: "messages"');
  });

  test('starts at 0001', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-release-new-'));
    expect(basename(createMigration(findProject(root), 'first', 'users'))).toBe('0001_first.ts');
  });
});

describe('createSeed', () => {
  test('numbers after the highest numbered seed, ignoring unnumbered ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-release-new-'));
    mkdirSync(join(root, 'convex/seeds'), { recursive: true });
    writeFileSync(join(root, 'convex/seeds/03_users.ts'), '');
    writeFileSync(join(root, 'convex/seeds/extra.ts'), '');
    const path = createSeed(findProject(root), 'messages', 'messages');
    expect(basename(path)).toBe('04_messages.ts');
    expect(readFileSync(path, 'utf8')).toContain('defineSeed("messages", {');
  });

  test('starts at 01', () => {
    const root = mkdtempSync(join(tmpdir(), 'convex-release-new-'));
    expect(basename(createSeed(findProject(root), 'users', 'users'))).toBe('01_users.ts');
  });
});
