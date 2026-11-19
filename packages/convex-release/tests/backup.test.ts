// The backup the release images take before migrating, written to a real folder
// from a stand-in for the backend's export.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vite-plus/test';

import { backupBeforeMigrate, type BackupOptions } from '../src/image/backup.ts';

const NOW = new Date('2026-11-18T09:05:03Z');

function setup(overrides: Partial<BackupOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'convex-release-backup-'));
  const lines: string[] = [];
  let exports = 0;
  const options: BackupOptions = {
    dir,
    keep: 3,
    from: '1.0.0',
    to: '2.0.0',
    now: NOW,
    log: (line) => lines.push(line),
    exportZip: async () => {
      exports++;
      return { body: [Buffer.from('zip '), Buffer.from('bytes')], size: 9 };
    },
    ...overrides,
  };
  return { dir, lines, options, exports: () => exports };
}

test('writes the export as <UTC time>-<from>-to-<to>.zip', async () => {
  const { dir, lines, options } = setup();
  expect(await backupBeforeMigrate(options)).toEqual({ file: '20261118-090503-1.0.0-to-2.0.0.zip', taken: true });
  expect(lines).toEqual(['backup: exporting the deployment before migrating', 'backup: wrote 20261118-090503-1.0.0-to-2.0.0.zip']);
  expect(readdirSync(dir)).toEqual(['20261118-090503-1.0.0-to-2.0.0.zip']);
  expect(readFileSync(join(dir, '20261118-090503-1.0.0-to-2.0.0.zip'), 'utf8')).toBe('zip bytes');
});

test('a release without a recorded or declared version is named unknown, and a version is made safe for a file name', async () => {
  const { options } = setup({ from: undefined, to: '2.0.0+build/7' });
  expect((await backupBeforeMigrate(options)).file).toBe('20261118-090503-unknown-to-2.0.0+build_7.zip');
});

test('keeps the newest backups up to `keep`, and leaves other files and folders alone', async () => {
  const { dir, lines, options } = setup({ keep: 2 });
  for (const name of ['20250101-000000-0.1.0-to-0.2.0.zip', '20260101-000000-0.2.0-to-1.0.0.zip', 'notes.txt', 'mine.zip']) writeFileSync(join(dir, name), '');
  mkdirSync(join(dir, '20240101-000000-a-to-b.zip'));
  await backupBeforeMigrate(options);
  expect(readdirSync(dir).sort()).toEqual([
    '20240101-000000-a-to-b.zip',
    '20260101-000000-0.2.0-to-1.0.0.zip',
    '20261118-090503-1.0.0-to-2.0.0.zip',
    'mine.zip',
    'notes.txt',
  ]);
  expect(lines).toContain('backup: deleted 20250101-000000-0.1.0-to-0.2.0.zip (CONVEX_RELEASE_BACKUP_KEEP=2)');
});

test("deletes a download an earlier, killed attempt didn't finish", async () => {
  const { dir, options } = setup();
  writeFileSync(join(dir, '20261117-120000-1.0.0-to-2.0.0.zip.partial'), 'cut off');
  await backupBeforeMigrate(options);
  expect(readdirSync(dir)).toEqual(['20261118-090503-1.0.0-to-2.0.0.zip']);
});

test('a failed or cut-off export fails the backup, leaving the folder as it was', async () => {
  async function* cutOff() {
    yield Buffer.from('zip ');
    throw new Error('connection reset');
  }
  const failures: [BackupOptions['exportZip'], string][] = [
    [() => Promise.reject(new Error('/api/export/request/zip: HTTP 500: disk full')), 'backup failed: /api/export/request/zip: HTTP 500: disk full'],
    [async () => ({ body: cutOff() }), 'backup failed: connection reset'],
    [async () => ({ body: [Buffer.from('zip ')], size: 9 }), 'backup failed: the download has 4 bytes, the export 9'],
  ];
  for (const [exportZip, message] of failures) {
    const { dir, options } = setup({ keep: 1, exportZip });
    writeFileSync(join(dir, '20260101-000000-0.2.0-to-1.0.0.zip'), 'older');
    await expect(backupBeforeMigrate(options)).rejects.toThrow(message);
    expect(readdirSync(dir)).toEqual(['20260101-000000-0.2.0-to-1.0.0.zip']);
  }
});

test('reuses the backup an earlier attempt recorded, without exporting again', async () => {
  const { dir, lines, options, exports } = setup();
  writeFileSync(join(dir, '20261117-120000-1.0.0-to-1.5.0.zip'), 'clean');
  const result = await backupBeforeMigrate({ ...options, recorded: '20261117-120000-1.0.0-to-1.5.0.zip' });
  expect(result).toEqual({ file: '20261117-120000-1.0.0-to-1.5.0.zip', taken: false });
  expect(exports()).toBe(0);
  expect(readdirSync(dir)).toEqual(['20261117-120000-1.0.0-to-1.5.0.zip']);
  expect(lines).toEqual(['backup: reusing 20261117-120000-1.0.0-to-1.5.0.zip, taken before an earlier attempt at this upgrade']);
});

test('takes a new backup when the recorded one is missing or never completed', async () => {
  for (const recorded of ['20261117-120000-1.0.0-to-1.5.0.zip', '20261117-120000-1.0.0-to-1.5.0.zip.partial']) {
    const { dir, lines, options } = setup();
    writeFileSync(join(dir, '20261117-120000-1.0.0-to-1.5.0.zip.partial'), 'cut off');
    expect(await backupBeforeMigrate({ ...options, recorded })).toEqual({ file: '20261118-090503-1.0.0-to-2.0.0.zip', taken: true });
    expect(lines[0]).toBe(`backup: ${recorded}, recorded by an earlier attempt, isn't in the backup folder; taking a new one`);
  }
});
