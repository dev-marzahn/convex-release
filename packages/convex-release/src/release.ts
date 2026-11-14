// A release: bring a deployment's code and data to this checkout.
//
// The same three steps the release image runs at startup:
//   1. push the code with schema validation off, so the new code and indexes
//      are live even though existing documents don't match yet;
//   2. run the pending migrations until they're all done;
//   3. push again with validation on, which checks every document.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { writeGenerated } from './codegen.ts';
import { push, runFunction, type PushTarget } from './convex-cli.ts';
import type { ReleaseStatus } from './index.ts';
import type { Project } from './project.ts';
import { copyProject } from './relaxed.ts';

export const START = 'migrations/_generated:start';
export const STATUS = 'migrations/_generated:status';

/** A read right after `start` can still show an old failure; see the entrypoint. */
const FAILED_READS = 3;

export interface ReleaseTarget {
  push: PushTarget;
  /** Flags for `convex run`, choosing the same deployment. */
  runArgs: string[];
}

/** The dev deployment, as `convex dev` picks it. */
export const devTarget: ReleaseTarget = { push: { kind: 'dev' }, runArgs: [] };

/**
 * The deployment `convex deploy` would pick: `--deployment` if given, else a
 * deploy key or self-hosted URL from the environment, else the project's prod.
 */
export function deployTarget(project: Project, deployment?: string): ReleaseTarget {
  if (deployment) return { push: { kind: 'deploy', args: ['--deployment', deployment] }, runArgs: ['--deployment', deployment] };
  const env = projectEnv(project);
  const fromEnv = Boolean(env.CONVEX_DEPLOY_KEY || env.CONVEX_SELF_HOSTED_URL);
  return { push: { kind: 'deploy', args: [] }, runArgs: fromEnv ? [] : ['--prod'] };
}

/** The variables the `convex` CLI reads: `.env`, then `.env.local`, then the shell. */
function projectEnv(project: Project): Record<string, string | undefined> {
  return { ...readEnvFile(project, '.env'), ...readEnvFile(project, '.env.local'), ...process.env };
}

/**
 * Without a configured deployment, `convex dev --once` in the temporary copy
 * would quietly create a throwaway anonymous one instead of failing.
 */
function assertConfigured(project: Project) {
  const env = projectEnv(project);
  if (env.CONVEX_DEPLOYMENT || env.CONVEX_SELF_HOSTED_URL || env.CONVEX_DEPLOY_KEY) return;
  throw new Error('No Convex deployment is configured here. Run `npx convex dev` once to set one up, or set CONVEX_DEPLOY_KEY.');
}

function readEnvFile(project: Project, name: string): Record<string, string> {
  const path = join(project.root, name);
  if (!existsSync(path)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

export interface ReleaseEvents {
  step: (message: string) => void;
  progress: (status: ReleaseStatus) => void;
}

export async function release(project: Project, target: ReleaseTarget, events: ReleaseEvents, pollMs = 1000): Promise<ReleaseStatus> {
  assertConfigured(project);
  writeGenerated(project);

  events.step('Pushing with schema validation off');
  const copy = copyProject(project);
  try {
    copy.relaxSchema();
    push(copy.project, target.push, ['--codegen', 'disable']);
  } finally {
    copy.dispose();
  }

  events.step('Running migrations');
  const result = await runMigrations(project, target.runArgs, events.progress, pollMs);
  if (result.state !== 'done') return result;

  events.step('Pushing with schema validation on');
  push(project, target.push);
  return result;
}

export async function runMigrations(project: Project, runArgs: string[], onProgress: (status: ReleaseStatus) => void, pollMs = 1000): Promise<ReleaseStatus> {
  runFunction(project, START, runArgs);
  let failedReads = 0;
  for (;;) {
    const status = runFunction<ReleaseStatus>(project, STATUS, runArgs);
    if (status.state === 'failed' && ++failedReads < FAILED_READS) {
      await sleep(pollMs);
      continue;
    }
    if (status.state !== 'failed') failedReads = 0;
    onProgress(status);
    if (status.state !== 'running') return status;
    await sleep(pollMs);
  }
}
