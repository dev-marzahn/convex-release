import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vite-plus/test';

import { findProject } from '../src/project.ts';
import { verify } from '../src/verify.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
};

/** A repo whose `main` has two shipped migrations; the test changes the working tree after. */
function repo(subdir = '') {
  const root = mkdtempSync(join(tmpdir(), 'convex-release-verify-'));
  const app = join(root, subdir);
  const dir = join(app, 'convex/migrations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '0001_rename_body.ts'), 'export default 1;\n');
  writeFileSync(join(dir, '0002_add_length.ts'), 'export default 2;\n');
  writeFileSync(join(dir, '_generated.ts'), '');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return { project: findProject(app), dir };
}

const levels = (issues: { level: string; migration: string }[]) => issues.map((i) => `${i.level}:${i.migration}`);

describe('verify', () => {
  test('a new migration after the shipped ones is fine', () => {
    const { project, dir } = repo();
    writeFileSync(join(dir, '0003_users.ts'), 'export default 3;\n');
    expect(verify(project, 'main')).toEqual([]);
  });

  test('removing a shipped migration is an error', () => {
    const { project, dir } = repo();
    rmSync(join(dir, '0001_rename_body.ts'));
    expect(levels(verify(project, 'main'))).toEqual(['error:0001_rename_body']);
  });

  test('renumbering is called out as such', () => {
    const { project, dir } = repo();
    renameSync(join(dir, '0002_add_length.ts'), join(dir, '0005_add_length.ts'));
    const [issue] = verify(project, 'main');
    expect(issue).toMatchObject({ level: 'error', migration: '0002_add_length' });
    expect(issue!.message).toContain('renumbered to 0005_add_length');
  });

  test('a new migration numbered before a shipped one is an error', () => {
    const { project, dir } = repo();
    renameSync(join(dir, '0002_add_length.ts'), join(dir, '0003_add_length.ts'));
    git(join(project.root), 'add', '-A');
    git(join(project.root), 'commit', '-qm', 'ship 0003');
    writeFileSync(join(dir, '0002_late.ts'), 'export default 9;\n');
    expect(levels(verify(project, 'main'))).toContain('error:0002_late');
  });

  test('editing a shipped migration is a warning', () => {
    const { project, dir } = repo();
    writeFileSync(join(dir, '0002_add_length.ts'), 'export default 22;\n');
    expect(levels(verify(project, 'main'))).toEqual(['warning:0002_add_length']);
  });

  test('works when the Convex project is a subfolder of the repo', () => {
    const { project, dir } = repo('apps/backend');
    rmSync(join(dir, '0002_add_length.ts'));
    expect(levels(verify(project, 'main'))).toEqual(['error:0002_add_length']);
  });

  test('a base with no migrations folder has nothing shipped', () => {
    const { project } = repo();
    git(project.root, 'checkout', '-q', '--orphan', 'empty');
    git(project.root, 'rm', '-rq', '--cached', '.');
    git(project.root, 'commit', '-q', '--allow-empty', '-m', 'empty');
    expect(verify(project, 'empty')).toEqual([]);
  });

  test('an unknown base explains how to fetch it', () => {
    const { project } = repo();
    expect(() => verify(project, 'origin/nope')).toThrow(/Fetch it first/);
  });
});
