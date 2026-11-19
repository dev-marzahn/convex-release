// The release images' start-up sequence. The entrypoint supplies the steps
// (HTTP calls to the backend); this file decides their order and when each
// one runs. Any failure rejects at once, so no later step runs.
import { backupBeforeMigrate, type ExportStream } from './backup.ts';
import type { HookName } from './hooks.ts';

/** Deployment variable: the version of the release last applied. */
export const VERSION_VARIABLE = 'CONVEX_RELEASE_VERSION';
/** Deployment variable: the backup taken before the release now being applied, until it applies. */
export const BACKUP_VARIABLE = 'CONVEX_RELEASE_BACKUP';

/** The container's settings for the sequence. */
export interface Settings {
  /** CONVEX_RELEASE_SNAPSHOT. */
  snapshot?: string;
  /** CONVEX_RELEASE_SEED. */
  seed: boolean;
  /** CONVEX_RELEASE_PRE_PUSH and CONVEX_RELEASE_POST_APPLY. */
  hooks: Partial<Record<HookName, string>>;
  /** CONVEX_RELEASE_BACKUP_DIR and CONVEX_RELEASE_BACKUP_KEEP. */
  backup?: { dir: string; keep: number };
}

/** The sequence's settings from the container's environment. Empty counts as unset. */
export function readSettings(env: Record<string, string | undefined>): Settings {
  const value = (name: string) => env[name] || undefined;
  const hooks: Settings['hooks'] = {};
  if (value('CONVEX_RELEASE_PRE_PUSH')) hooks['pre-push'] = value('CONVEX_RELEASE_PRE_PUSH');
  if (value('CONVEX_RELEASE_POST_APPLY')) hooks['post-apply'] = value('CONVEX_RELEASE_POST_APPLY');
  const keep = value('CONVEX_RELEASE_BACKUP_KEEP') ?? '3';
  if (!/^\d+$/.test(keep) || Number(keep) < 1) throw new Error(`CONVEX_RELEASE_BACKUP_KEEP is ${keep}; it has to be a whole number of 1 or more`);
  const dir = value('CONVEX_RELEASE_BACKUP_DIR');
  const snapshot = value('CONVEX_RELEASE_SNAPSHOT');
  return {
    hooks,
    ...(dir ? { backup: { dir, keep: Number(keep) } } : {}),
    ...(snapshot ? { snapshot } : {}),
    seed: /^(1|true|yes)$/i.test(env.CONVEX_RELEASE_SEED ?? ''),
  };
}

/** One-shot mode deploys to the backend at CONVEX_URL; the combined image, to the backend it runs itself. */
export type Mode = { kind: 'combined' | 'oneshot'; url: string };

export function modeFromEnv(env: Record<string, string | undefined>, hasBackend: boolean): Mode {
  if (env.CONVEX_URL) return { kind: 'oneshot', url: env.CONVEX_URL.replace(/\/+$/, '') };
  // The one-shot image has no backend of its own.
  if (!hasBackend) throw new Error('set CONVEX_URL to the backend this image deploys to.');
  return { kind: 'combined', url: `http://127.0.0.1:${env.PORT ?? 3210}` };
}

/** The container around the sequence. */
export interface Host extends Pick<ApplyContext, 'release' | 'runHook' | 'log' | 'now'> {
  /** Combined mode: starts the backend in this container. */
  startBackend(): void;
  removeReady(): void;
  writeReady(): void;
  adminKey(mode: Mode): string;
  deployment(url: string, key: string): Deployment;
}

/**
 * Applies the release in either mode. The combined image's health check
 * passes once the ready file exists, so it's removed first (a restarted
 * container keeps its /tmp) and written only after the last step.
 */
export async function run(mode: Mode, settings: Settings, host: Host): Promise<void> {
  if (mode.kind === 'combined') {
    host.removeReady();
    host.startBackend();
  }
  const key = host.adminKey(mode);
  if (mode.kind === 'oneshot') host.log(`deploying to ${mode.url}`);
  await applyRelease({ ...host, url: mode.url, key, settings, deployment: host.deployment(mode.url, key) });
  if (mode.kind === 'combined') {
    host.writeReady();
    host.log('ready');
  } else {
    host.log('deployed');
  }
}

/** What the image holds. */
export interface Release {
  /** release.json's `version`. */
  version?: string;
  /** Whether push.relaxed.json exists: the release has migrations to run between two pushes. */
  relaxed: boolean;
}

/** The steps, against one deployment. */
export interface Deployment {
  waitUntilUp(): Promise<void>;
  /**
   * Refuses a release older than the data. After `start`, resolves to true
   * when CONVEX_RELEASE_ON_DOWNGRADE=reset deleted the data instead.
   */
  checkDowngrade(after: 'start' | 'snapshot'): Promise<boolean>;
  predeployChecks(): Promise<void>;
  /** The release's migrations the deployment hasn't finished. */
  pendingMigrations(): Promise<number>;
  /** No documents in the app's tables. */
  isEmpty(): Promise<boolean>;
  getVariable(name: string): Promise<string | undefined>;
  /** `null` removes a variable. */
  setVariables(changes: Record<string, string | null>): Promise<void>;
  exportZip(): Promise<ExportStream>;
  push(kind: 'relaxed' | 'strict', label: string): Promise<void>;
  /** Imports CONVEX_RELEASE_SNAPSHOT, replacing everything. */
  importSnapshot(): Promise<void>;
  migrate(): Promise<void>;
  seed(): Promise<void>;
}

export interface ApplyContext {
  /** The deployment's URL and admin key, as the hooks get them. */
  url: string;
  key: string;
  settings: Settings;
  release: Release;
  deployment: Deployment;
  runHook: (name: HookName, command: string, env: Record<string, string>) => Promise<void>;
  log: (line: string) => void;
  now: () => Date;
}

export async function applyRelease(ctx: ApplyContext): Promise<void> {
  const { deployment: d, settings, release } = ctx;
  const hook = async (name: HookName) => {
    const command = settings.hooks[name];
    if (!command) return;
    // Neither the command nor the environment goes in the log: either can hold a secret.
    ctx.log(`${name} hook: running`);
    await ctx.runHook(name, command, { CONVEX_URL: ctx.url, CONVEX_ADMIN_KEY: ctx.key });
    ctx.log(`${name} hook: done`);
  };

  /** What the deployment has recorded, as it changes below. */
  const recorded = { version: undefined as string | undefined, backup: undefined as string | undefined };
  const record = async (version: string | undefined, backup: string | undefined) => {
    const changes: Record<string, string | null> = {};
    if (version !== recorded.version) changes[VERSION_VARIABLE] = version ?? null;
    if (backup !== recorded.backup) changes[BACKUP_VARIABLE] = backup ?? null;
    if (Object.keys(changes).length === 0) return;
    await d.setVariables(changes);
    Object.assign(recorded, { version, backup });
  };

  await d.waitUntilUp();
  const wiped = await d.checkDowngrade('start');
  await d.predeployChecks();
  recorded.version = await d.getVariable(VERSION_VARIABLE);
  recorded.backup = await d.getVariable(BACKUP_VARIABLE);
  // The records described the data that was just replaced.
  if (wiped) await record(undefined, undefined);
  if (settings.backup && (await d.pendingMigrations()) > 0 && !(await d.isEmpty())) {
    const { file } = await backupBeforeMigrate({
      ...settings.backup,
      from: recorded.version,
      to: release.version,
      recorded: recorded.backup,
      now: ctx.now(),
      log: ctx.log,
      exportZip: () => d.exportZip(),
    });
    await record(recorded.version, file);
  }
  await hook('pre-push');
  await d.push(release.relaxed ? 'relaxed' : 'strict', release.relaxed ? 'pass 1 (validation off)' : 'push');
  // After pass 1, so the migrations component exists to take its records.
  if (settings.snapshot && (await d.isEmpty())) {
    await d.importSnapshot();
    await record(undefined, undefined);
    await d.checkDowngrade('snapshot');
  }
  if (release.relaxed) {
    await d.migrate();
    await d.push('strict', 'pass 2 (validation on)');
  }
  // The data now matches this release, so a later attempt needs no backup of its own.
  await record(release.version, undefined);
  if (settings.seed) await d.seed();
  await hook('post-apply');
}
