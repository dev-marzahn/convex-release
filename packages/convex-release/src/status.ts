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
  /** Recorded on the deployment but not in this checkout: from a newer version if done, else renamed or deleted. */
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

function rowState(s: ComponentStatus): MigrationState {
  if (s.isDone) return 'done';
  if (s.state === 'failed') return 'failed';
  if (s.state === 'canceled') return 'canceled';
  return s.state === 'inProgress' ? 'running' : 'pending';
}

function row(s: ComponentStatus): MigrationRow {
  return { name: s.name, state: rowState(s), processed: s.processed, ...(s.error ? { error: s.error } : {}) };
}

export function migrationRows(local: string[], recorded: ComponentStatus[]): MigrationRow[] {
  const byName = new Map(recorded.map((s) => [s.name, s]));
  const rows: MigrationRow[] = local.map((name) => {
    const s = byName.get(name);
    return s ? row(s) : { name, state: 'pending', processed: 0 };
  });
  const known = new Set(local);
  for (const s of recorded) {
    if (!known.has(s.name)) rows.push({ ...row(s), unknown: true });
  }
  return rows;
}

export function readStatus(project: Project, runArgs: string[]): MigrationRow[] {
  const local = listMigrations(project.migrationsDir).map((m) => functionName(m.module));
  const recorded = runFunction<ComponentStatus[]>(project, 'lib:getStatus', ['--component', 'migrations', ...runArgs], { limit: 1000 });
  return migrationRows(local, recorded);
}
