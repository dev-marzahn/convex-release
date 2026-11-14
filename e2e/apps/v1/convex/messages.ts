import { v } from 'convex/values';

import { mutation } from './_generated/server';

export const send = mutation({
  args: { body: v.string(), author: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert('messages', args);
  },
});

/** Test helper: inserts chunk `chunk` of `size` messages from `authors` distinct authors. */
export const seed = mutation({
  args: { chunk: v.number(), size: v.number(), authors: v.number() },
  handler: async (ctx, { chunk, size, authors }) => {
    for (let i = chunk * size; i < (chunk + 1) * size; i++) {
      await ctx.db.insert('messages', { body: `v1 seeded ${i} ${'x'.repeat(200)}`, author: `user${i % authors}` });
    }
  },
});
