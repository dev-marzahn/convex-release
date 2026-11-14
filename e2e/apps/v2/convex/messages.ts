import { v } from 'convex/values';

import { mutation } from './_generated/server';

export const send = mutation({
  args: { text: v.string(), author: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert('messages', args);
  },
});
