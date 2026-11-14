import { v } from 'convex/values';

import { mutation, query } from './_generated/server';
import { userByName } from './users';

export const list = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db.query('messages').collect();
    return Promise.all(
      messages.map(async (m) => ({
        text: m.text,
        author: (await ctx.db.get('users', m.authorId))?.name,
      })),
    );
  },
});

export const send = mutation({
  args: { text: v.string(), author: v.string() },
  handler: async (ctx, { text, author }) => {
    const authorId = await userByName(ctx, author);
    await ctx.db.insert('messages', { text, length: text.length, authorId });
  },
});
