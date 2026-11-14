import { expect, test } from 'vite-plus/test';

import { deployWorkflow, imageWorkflow, toolchain } from '../src/ci.ts';

test('the deploy workflow verifies pull requests and deploys pushes', () => {
  const yaml = deployWorkflow({ tools: toolchain('bun'), branch: 'trunk', dir: '' });
  expect(yaml).toContain('branches: [trunk]');
  expect(yaml).toContain('run: bunx convex-release verify');
  expect(yaml).toContain('run: bunx convex-release deploy --timeout 1800');
  expect(yaml).toContain('fetch-depth: 0');
  expect(yaml).not.toContain('working-directory');
});

test('a project in a subfolder runs its steps there', () => {
  const yaml = deployWorkflow({ tools: toolchain('npm'), branch: 'main', dir: 'apps/backend' });
  expect(yaml).toContain('working-directory: apps/backend');
  expect(yaml).toContain('run: npm ci');
  expect(yaml).toContain('run: npx convex-release verify');
});

test('the image workflow tests the upgrade from the previous tag before pushing', () => {
  const yaml = imageWorkflow({ tools: toolchain('pnpm'), branch: 'main', dir: '' });
  const upgrade = yaml.indexOf('convex-release test-upgrade');
  const push = yaml.indexOf('--push');
  expect(upgrade).toBeGreaterThan(0);
  expect(push).toBeGreaterThan(upgrade);
  expect(yaml).toContain('--platform linux/amd64,linux/arm64');
  expect(yaml).toContain('pnpm exec convex-release test-upgrade');
});
