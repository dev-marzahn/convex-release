// The export the release images take before migrating (CONVEX_RELEASE_BACKUP_DIR).
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface ExportStream {
  /** The zip's bytes. */
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  /** The size the backend reports, when it does: a shorter download fails the backup. */
  size?: number;
}

export interface BackupOptions {
  dir: string;
  /** How many backups to keep in `dir`. */
  keep: number;
  /** The release last applied to the deployment, if recorded. */
  from?: string;
  /** The release about to be applied, if it has a version. */
  to?: string;
  /** The backup the deployment recorded (CONVEX_RELEASE_BACKUP): taken before an earlier attempt that hasn't applied yet. */
  recorded?: string;
  now: Date;
  log: (line: string) => void;
  exportZip: () => Promise<ExportStream>;
}

export interface BackupResult {
  /** The backup's file name in `dir`. */
  file: string;
  /** False when an earlier attempt's backup was reused. */
  taken: boolean;
}

/** `yyyymmdd-hhmmss`, UTC. */
function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replaceAll(/[-:]/g, '')
    .replace('T', '-');
}

/** A version as it goes into a file name: `unknown` when absent, other characters than `A-Za-z0-9._+-` as `_`. */
const label = (version: string | undefined) => (version ? version.replaceAll(/[^\w.+-]/g, '_') : 'unknown');

/** A complete backup's name; a download in progress has `.partial` appended. */
const BACKUP_NAME = /^\d{8}-\d{6}-.+-to-.+\.zip$/;

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/**
 * Takes one export into `dir`, unless `recorded` names a complete backup
 * there: the deployment records the backup it took until a release applies
 * successfully, so every attempt in between, whatever its target release,
 * reuses the export taken before the first one.
 */
export async function backupBeforeMigrate(options: BackupOptions): Promise<BackupResult> {
  const { recorded } = options;
  if (recorded) {
    if (BACKUP_NAME.test(recorded) && isFile(join(options.dir, recorded))) {
      options.log(`backup: reusing ${recorded}, taken before an earlier attempt at this upgrade`);
      return { file: recorded, taken: false };
    }
    options.log(`backup: ${recorded}, recorded by an earlier attempt, isn't in the backup folder; taking a new one`);
  }
  const file = `${stamp(options.now)}-${label(options.from)}-to-${label(options.to)}.zip`;
  const target = join(options.dir, file);
  const partial = `${target}.partial`;
  let backups: string[];
  try {
    await mkdir(options.dir, { recursive: true });
    backups = (await readdir(options.dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    for (const name of backups) if (name.endsWith('.partial') && BACKUP_NAME.test(name.slice(0, -'.partial'.length))) await rm(join(options.dir, name));
    options.log('backup: exporting the deployment before migrating');
    const exported = await options.exportZip();
    let bytes = 0;
    await pipeline(
      Readable.from(exported.body),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          bytes += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    if (exported.size !== undefined && bytes !== exported.size) throw new Error(`the download has ${bytes} bytes, the export ${exported.size}`);
    await rename(partial, target);
    options.log(`backup: wrote ${file}`);
  } catch (err) {
    await rm(partial, { force: true }).catch(() => {});
    throw new Error(`backup failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  // Names start with the UTC time, so they sort oldest first.
  const older = backups.filter((name) => BACKUP_NAME.test(name) && name !== file);
  for (const name of older.sort().slice(0, Math.max(0, older.length + 1 - options.keep))) {
    await rm(join(options.dir, name));
    options.log(`backup: deleted ${name} (CONVEX_RELEASE_BACKUP_KEEP=${options.keep})`);
  }
  return { file, taken: true };
}
