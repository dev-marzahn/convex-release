'use node';
// Runs in the backend's Node executor rather than the isolate.
import { createHash } from 'node:crypto';

import { v } from 'convex/values';

import { action } from './_generated/server';

export const sha256 = action({
  args: { text: v.string() },
  handler: async (_ctx, { text }) => `${process.version} ${createHash('sha256').update(text).digest('hex')}`,
});
