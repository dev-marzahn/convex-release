import { v } from 'convex/values';

import { mutation, query } from './_generated/server.js';

/** The reason of the first flag, or null when nothing blocks a release. */
export const isBlocked = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => (await ctx.db.query('flags').first())?.reason ?? null,
});

export const block = mutation({
  args: { reason: v.string() },
  returns: v.null(),
  handler: async (ctx, { reason }) => {
    await ctx.db.insert('flags', { reason });
    return null;
  },
});

export const unblock = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    for (const flag of await ctx.db.query('flags').collect()) await ctx.db.delete(flag._id);
    return null;
  },
});
