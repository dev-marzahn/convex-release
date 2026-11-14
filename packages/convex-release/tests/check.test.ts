import { expect, test } from 'vite-plus/test';

import { parseMismatch } from '../src/check.ts';

test('reads the table and reason from the backend error', () => {
  const output = [
    'Pushing code to your Convex deployment...',
    '✖ Schema validation failed.',
    'Document with ID "j570076sc5eb49fxwphd7c0aen8j6rk0" in table "messages" does not match the schema: Object is missing the required field `authorId`.',
    '',
    'Object: {author: "user13"}',
  ].join('\n');
  expect(parseMismatch(output)).toEqual({ table: 'messages', message: 'Object is missing the required field `authorId`.' });
});

test('other failures are not a mismatch', () => {
  expect(parseMismatch('✖ Error: Unable to reach the deployment')).toBeUndefined();
});
