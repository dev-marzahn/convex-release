import { expect, test } from 'vite-plus/test';

import { migrationRows } from '../src/status.ts';

const a = 'migrations/0001_a';
const b = 'migrations/0002_b';

test('joins local migrations with what the deployment recorded', () => {
  const rows = migrationRows(
    [a, b],
    [
      { name: a, isDone: true, state: 'success', processed: 300 },
      { name: 'migrations/0003_c', isDone: true, state: 'success', processed: 10 },
    ],
  );
  expect(rows).toEqual([
    { name: a, state: 'done', processed: 300 },
    { name: b, state: 'pending', processed: 0 },
    { name: 'migrations/0003_c', state: 'done', processed: 10, unknown: true },
  ]);
});

test('keeps the recorded state of a migration the checkout no longer has', () => {
  const rows = migrationRows([b], [{ name: a, isDone: false, state: 'failed', processed: 40, error: 'boom' }]);
  expect(rows).toContainEqual({ name: a, state: 'failed', processed: 40, error: 'boom', unknown: true });
});

test('reports failures with their error', () => {
  const [row] = migrationRows([a], [{ name: a, isDone: false, state: 'failed', processed: 100, error: 'boom\n  at x' }]);
  expect(row).toEqual({ name: a, state: 'failed', processed: 100, error: 'boom\n  at x' });
});
