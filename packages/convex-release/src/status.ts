// `convex-release status`: each migration as the deployment has recorded it.
import { listMigrations } from './codegen.ts';
import { runFunction } from './convex-cli.ts';
import type { Project } from './project.ts';

export type MigrationState = 'done' | 'running' | 'pending' | 'failed' | 'canceled';

export interface MigrationRow {
  name: string;
  state: MigrationState;
  processed: number;
  error?: string;
  /** Recorded on the deployment but not in this checkout: from a newer release. */
  unknown?: boolean;
}

interface ComponentStatus {
  name: string;
  isDone: boolean;
  state: 'inProgress' | 'success' | 'failed' | 'canceled' | 'unknown';
  processed: number;
  error?: string;
}

/**
 * The name the migrations component records, e.g. `migrations/0001_rename_body`:
 * Convex leaves `:default` off a module's default export.
 */
export function functionName(module: string): string {
  return `migrations/${module}`;
}

export function migrationRows(local: string[], recorded: ComponentStatus[]): MigrationRow[] {
  const byName = new Map(recorded.map((s) => [s.name, s]));
  const rows: MigrationRow[] = local.map((name) => {
    const s = byName.get(name);
    if (!s) return { name, state: 'pending', processed: 0 };
    const state: MigrationState = s.isDone
      ? 'done'
      : s.state === 'failed'
        ? 'failed'
        : s.state === 'canceled'
          ? 'canceled'
          : s.state === 'inProgress'
            ? 'running'
            : 'pending';
    return { name, state, processed: s.processed, ...(s.error ? { error: s.error } : {}) };
  });
  const known = new Set(local);
  for (const s of recorded) {
    if (!known.has(s.name)) rows.push({ name: s.name, state: s.isDone ? 'done' : 'pending', processed: s.processed, unknown: true });
  }
  return rows;
}

export function readStatus(project: Project, runArgs: string[]): MigrationRow[] {
  const local = listMigrations(project.migrationsDir).map((m) => functionName(m.module));
  const recorded = runFunction<ComponentStatus[]>(project, 'lib:getStatus', ['--component', 'migrations', ...runArgs], { limit: 1000 });
  return migrationRows(local, recorded);
}
