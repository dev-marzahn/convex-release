// `convex-release check`: does this checkout's schema accept the deployment's
// data, and if not, will pending migrations run first? Changes nothing: it's
// a `convex deploy --dry-run`, which validates every document and rolls back.
// It also runs the dependencies' predeploy checks, which are expected only to
// read; the CLI path doesn't enforce that.
import { spawnSync } from 'node:child_process';

import { listMigrations, writeGenerated } from './codegen.ts';
import { convexBin } from './convex-cli.ts';
import { applySkips, discoverChecks, type CheckOutcome, type Log } from './predeploy.ts';
import type { Project } from './project.ts';
import { predeployChecks } from './release.ts';
import { functionName, readStatus } from './status.ts';

export interface CheckResult {
  /** The strict schema accepts every document as the data is now. */
  matches: boolean;
  /** Migrations in this checkout the deployment hasn't finished. */
  pending: string[];
  /** The first document the schema rejects, as the backend reports it. */
  mismatch?: { table?: string; message: string };
  /** One outcome per declared predeploy check, skipped ones included. */
  predeploy: CheckOutcome[];
  /** `--skip-check` names that no dependency declares. */
  warnings: string[];
}

export interface CheckTarget {
  /** Flags for `convex deploy --dry-run`. */
  deployArgs: string[];
  /** Flags for `convex run`, choosing the same deployment. */
  runArgs: string[];
}

export interface CheckOptions {
  skipChecks: string[];
  /** A line a predeploy check module printed. */
  log: Log;
}

export async function check(project: Project, target: CheckTarget, options: CheckOptions): Promise<CheckResult> {
  writeGenerated(project);
  const pending = pendingMigrations(project, target.runArgs);
  const result = spawnSync(process.execPath, [convexBin(project), 'deploy', '-y', '--dry-run', '--typecheck', 'disable', ...target.deployArgs], {
    cwd: project.root,
    encoding: 'utf8',
  });
  let schema: Pick<CheckResult, 'matches' | 'mismatch'> = { matches: true };
  if (result.status !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    const mismatch = parseMismatch(output);
    if (!mismatch) throw new Error(`\`convex deploy --dry-run\` failed:\n${output.trim()}`);
    schema = { matches: false, mismatch };
  }
  const declared = discoverChecks(project.root);
  const { run, skipped, warnings } = applySkips(
    declared.map((c) => c.packageName),
    options.skipChecks,
    '--skip-check',
  );
  const outcomes = await predeployChecks(
    project,
    target.runArgs,
    declared.filter((c) => run.has(c.packageName)),
    { log: options.log },
  );
  const predeploy = [...skipped, ...outcomes].sort((a, b) => (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0));
  return { matches: schema.matches, pending, ...(schema.mismatch ? { mismatch: schema.mismatch } : {}), predeploy, warnings };
}

/** The backend's schema validation error, e.g. `Document with ID "…" in table "messages" does not match the schema: …`. */
export function parseMismatch(output: string): { table: string; message: string } | undefined {
  const match = /in table "([^"]+)" does not match the schema: ([^\n]+)/.exec(output);
  return match ? { table: match[1]!, message: match[2]!.trim() } : undefined;
}

function pendingMigrations(project: Project, runArgs: string[]): string[] {
  try {
    return readStatus(project, runArgs)
      .filter((r) => !r.unknown && r.state !== 'done')
      .map((r) => r.name);
  } catch {
    // No migrations component deployed yet: every local migration is pending.
    return listMigrations(project.migrationsDir).map((m) => functionName(m.module));
  }
}
