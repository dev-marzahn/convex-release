// `convex-release build` and `convex-release test-upgrade`: Docker around the
// release images. Shells out to the `docker` CLI the user already has.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { ONESHOT_IMAGE } from './images.ts';
import type { Project } from './project.ts';

export class DockerError extends Error {}

function docker(args: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options });
  if (result.error) throw new DockerError("Docker isn't available: install it or start Docker Desktop.");
  if (result.status !== 0)
    throw new DockerError(
      `docker ${args[0]} failed:\n${String(result.stderr ?? '')
        .trim()
        .slice(-3000)}`,
    );
  return String(result.stdout ?? '');
}

export interface BuildOptions {
  tag: string;
  /** Build the one-shot variant instead of the project's Dockerfile. */
  oneshot?: boolean;
}

/** Builds the app image; its output streams to the terminal. */
export function build(project: Project, options: BuildOptions): void {
  if (options.oneshot) {
    // No second Dockerfile in the project: the one-shot one is a single FROM.
    docker(['build', '-t', options.tag, '-f-', project.root], { input: `FROM ${ONESHOT_IMAGE}\n`, stdio: ['pipe', 'inherit', 'inherit'] });
    return;
  }
  if (!existsSync(join(project.root, 'Dockerfile'))) throw new DockerError('No Dockerfile here. `convex-release init --docker` writes one.');
  docker(['build', '-t', options.tag, project.root], { stdio: ['ignore', 'inherit', 'inherit'] });
}

export interface UpgradeTestOptions {
  /** The release users run today, e.g. `my-app:1.3.0`. */
  from: string;
  /** The new release, e.g. `my-app:1.4.0`. */
  to: string;
  /** A function to call on `from` to create data, e.g. `testing:seed`. */
  seed?: string;
  /** A function to call on `to` afterwards; it should throw if the data is wrong. */
  check?: string;
  /** How long each release may take to become ready. */
  timeoutMs?: number;
}

export interface UpgradeTestEvents {
  step: (message: string) => void;
  log: (line: string) => void;
}

/**
 * Starts `from` on a fresh volume, optionally seeds it, then starts `to` on the
 * same volume and requires it to become healthy: the upgrade a user's
 * `docker compose up -d` would do. Cleans up after itself.
 */
export async function testUpgrade(options: UpgradeTestOptions, events: UpgradeTestEvents): Promise<void> {
  const id = randomBytes(4).toString('hex');
  const name = `convex-release-test-${id}`;
  const volume = `${name}-data`;
  const secret = randomBytes(32).toString('hex');
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const start = (image: string) => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    docker(['run', '-d', '--name', name, '-e', 'INSTANCE_NAME=release_test', '-e', `INSTANCE_SECRET=${secret}`, '-v', `${volume}:/convex/data`, image]);
  };
  try {
    events.step(`Starting ${options.from} on a fresh volume`);
    start(options.from);
    await waitHealthy(name, timeoutMs, events);
    if (options.seed) {
      events.step(`Seeding with ${options.seed}`);
      runFunction(name, options.seed);
    }
    events.step(`Upgrading to ${options.to}`);
    start(options.to);
    await waitHealthy(name, timeoutMs, events);
    if (options.check) {
      events.step(`Checking with ${options.check}`);
      runFunction(name, options.check);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
  }
}

async function waitHealthy(name: string, timeoutMs: number, events: UpgradeTestEvents) {
  const deadline = Date.now() + timeoutMs;
  let shown = 0;
  for (;;) {
    const [health, running, exitCode] = docker(['inspect', '-f', '{{.State.Health.Status}} {{.State.Running}} {{.State.ExitCode}}', name]).trim().split(' ');
    const lines = releaseLines(name);
    for (const line of lines.slice(shown)) events.log(line);
    shown = lines.length;
    if (health === 'healthy') return;
    if (running !== 'true') throw new DockerError(`The container exited with code ${exitCode} before it was ready.`);
    if (Date.now() > deadline) throw new DockerError(`Not ready after ${Math.round(timeoutMs / 1000)}s.`);
    await sleep(1000);
  }
}

function releaseLines(name: string): string[] {
  const result = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  return `${result.stdout}\n${result.stderr}`
    .split('\n')
    .filter((line) => line.startsWith('[convex-release]'))
    .map((line) => line.replace('[convex-release] ', ''));
}

/**
 * Calls a function inside the container, with the backend's own admin key.
 * `call` is a function name, optionally followed by JSON args:
 * `testing:seed {"count": 1000}`.
 */
function runFunction(name: string, call: string) {
  const [path = '', ...rest] = call.trim().split(/\s+/);
  const argsJson = rest.join(' ') || '{}';
  try {
    JSON.parse(argsJson);
  } catch {
    throw new DockerError(`The arguments after ${path} aren't JSON: ${argsJson}`);
  }
  const script = `
    const key = require('node:child_process').execFileSync('./generate_admin_key.sh', { encoding: 'utf8' }).trim().split('\\n').at(-1);
    fetch('http://127.0.0.1:3210/api/function', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Convex ' + key },
      body: JSON.stringify({ path: ${JSON.stringify(path)}, format: 'json', args: ${argsJson} }),
    }).then((r) => r.json()).then((r) => {
      if (r.status !== 'success') { console.error(r.errorMessage); process.exit(1); }
    });`;
  const result = spawnSync('docker', ['exec', name, 'node', '-e', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new DockerError(`${path} failed: ${result.stderr.trim()}`);
}
