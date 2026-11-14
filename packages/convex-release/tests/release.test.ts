import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vite-plus/test';

import { findProject } from '../src/project.ts';
import { deployTarget } from '../src/release.ts';

function project(envLocal?: string) {
  const root = mkdtempSync(join(tmpdir(), 'convex-release-target-'));
  if (envLocal) writeFileSync(join(root, '.env.local'), envLocal);
  return findProject(root);
}

describe('deployTarget', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('defaults to the project prod deployment', () => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', '');
    vi.stubEnv('CONVEX_SELF_HOSTED_URL', '');
    expect(deployTarget(project('CONVEX_DEPLOYMENT=dev:happy-otter-1'))).toEqual({ push: { kind: 'deploy', args: [] }, runArgs: ['--prod'] });
  });

  test('a deploy key in the environment picks the deployment itself', () => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', 'prod:happy-otter-1|key');
    expect(deployTarget(project()).runArgs).toEqual([]);
  });

  test('a self-hosted URL in .env.local is the deployment', () => {
    vi.stubEnv('CONVEX_DEPLOY_KEY', '');
    vi.stubEnv('CONVEX_SELF_HOSTED_URL', '');
    expect(deployTarget(project('CONVEX_SELF_HOSTED_URL="http://localhost:3210"\n')).runArgs).toEqual([]);
  });

  test('--deployment goes to both the push and the function calls', () => {
    expect(deployTarget(project(), 'staging')).toEqual({
      push: { kind: 'deploy', args: ['--deployment', 'staging'] },
      runArgs: ['--deployment', 'staging'],
    });
  });
});
