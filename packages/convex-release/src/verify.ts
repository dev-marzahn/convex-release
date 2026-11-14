// `convex-release verify`: compares the migrations with a base branch, without
// a deployment. Deployments on older releases upgrade by running every
// migration they haven't finished, in order, so shipped migrations have to
// stay where they are.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { listMigrations, MIGRATION_FILE } from './codegen.ts';
import type { Project } from './project.ts';

export interface VerifyIssue {
  level: 'error' | 'warning';
  migration: string;
  message: string;
}

/** The base to compare with: --base, else the pull request's target, else origin/main. */
export function defaultBase(): string {
  const target = process.env.GITHUB_BASE_REF;
  return target ? `origin/${target}` : 'origin/main';
}

function git(project: Project, args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', args, { cwd: project.root, encoding: 'utf8' });
  return { ok: result.status === 0, out: result.stdout ?? '', err: (result.stderr ?? '').trim() };
}

function gitOrThrow(project: Project, args: string[]): string {
  const result = git(project, args);
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.err}`);
  return result.out;
}

interface Shipped {
  number: number;
  module: string;
  slug: string;
  source: string;
}

/** The numbered migration files at `base`. */
function shippedMigrations(project: Project, base: string): Shipped[] {
  if (!git(project, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).ok) {
    throw new Error(`Can't find ${base} in git. Fetch it first (in CI: actions/checkout with fetch-depth: 0, or \`git fetch origin main\`).`);
  }
  // Paths in `<commit>:<path>` are relative to the repo root, not the project.
  const prefix = gitOrThrow(project, ['rev-parse', '--show-prefix']).trim();
  const dir = posix(join(prefix, relative(project.root, project.migrationsDir)));
  // --full-tree: run from a subfolder, ls-tree would otherwise filter by it.
  const listing = git(project, ['ls-tree', '--full-tree', '--name-only', `${base}:${dir}`]);
  // No migrations folder at the base: nothing has shipped yet.
  if (!listing.ok) return [];
  return listing.out
    .split('\n')
    .filter(Boolean)
    .flatMap((file) => {
      const match = MIGRATION_FILE.exec(file);
      if (!match) return [];
      const source = gitOrThrow(project, ['show', `${base}:${dir}/${file}`]);
      return [{ number: Number(match[1]), module: file.replace(/\.(ts|js)$/, ''), slug: match[2]!, source }];
    });
}

const posix = (path: string) => path.split('\\').join('/');

export function verify(project: Project, base: string): VerifyIssue[] {
  const shipped = shippedMigrations(project, base);
  const current = listMigrations(project.migrationsDir);
  return compareMigrations(
    shipped,
    current.map((m) => ({ ...m, slug: m.module.replace(/^\d+_/, ''), source: readFileSync(join(project.migrationsDir, m.file), 'utf8') })),
  );
}

/** A migration's file relative to the repo root, as GitHub annotations want it. */
export function repoPath(project: Project, module: string): string {
  const prefix = gitOrThrow(project, ['rev-parse', '--show-prefix']).trim();
  return posix(join(prefix, relative(project.root, project.migrationsDir), `${module}.ts`));
}

export function compareMigrations(shipped: Shipped[], current: { number: number; module: string; slug: string; source: string }[]): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const byModule = new Map(current.map((m) => [m.module, m]));
  const shippedModules = new Set(shipped.map((m) => m.module));
  for (const old of shipped) {
    const now = byModule.get(old.module);
    if (now) {
      if (now.source !== old.source) {
        issues.push({
          level: 'warning',
          migration: old.module,
          message: "changed after it shipped. Deployments that already ran it won't run it again; put new changes in a new migration.",
        });
      }
      continue;
    }
    const renumbered = current.find((m) => m.slug === old.slug && !shippedModules.has(m.module));
    issues.push({
      level: 'error',
      migration: old.module,
      message: renumbered
        ? `was renumbered to ${renumbered.module}. Deployments that ran ${old.module} would run it again under the new name; keep the old number.`
        : "was removed or renamed. Deployments on releases before it can't upgrade without it; restore it.",
    });
  }
  const highestShipped = Math.max(0, ...shipped.map((m) => m.number));
  for (const added of current.filter((m) => !shippedModules.has(m.module))) {
    if (added.number < highestShipped) {
      issues.push({
        level: 'error',
        migration: added.module,
        message: `is numbered below ${String(highestShipped).padStart(4, '0')}, which already shipped. Deployments that ran that one would run this one after it; give it a number above ${highestShipped}.`,
      });
    }
  }
  return issues;
}
