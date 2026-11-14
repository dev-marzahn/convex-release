import { v } from 'convex/values';

import { internalMutation, mutation } from './_generated/server';

export const send = mutation({
  args: { text: v.string(), author: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert('messages', { ...args, length: args.text.length });
  },
});

/** Test helper for `test-upgrade --seed`: internal, so clients can't call it. */
export const seedInternal = internalMutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    for (let i = 0; i < count; i++) {
      const text = `v3 msg ${i}`;
      await ctx.db.insert('messages', { text, length: text.length, author: `user${i % 10}` });
    }
  },
});
