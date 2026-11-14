import { v } from 'convex/values';

import { mutation, query } from './_generated/server';
import { userByName } from './users';

export const send = mutation({
  args: { text: v.string(), author: v.string() },
  handler: async (ctx, { text, author }) => {
    await ctx.db.insert('messages', { text, length: text.length, authorId: await userByName(ctx, author) });
  },
});

/** Test helper: one page of messages, summarised; the caller follows `cursor`. */
export const checkPage = query({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('messages').paginate({ cursor, numItems: 2000 });
    const authors = new Set<string>();
    let wellFormed = 0;
    for (const m of page.page) {
      const raw = m as unknown as Record<string, unknown>;
      const author = (await ctx.db.get('users', m.authorId))?.name;
      if (author) authors.add(author);
      if (author && m.length === m.text.length && raw.author === undefined && raw.body === undefined) wellFormed++;
    }
    return { count: page.page.length, wellFormed, authors: [...authors], isDone: page.isDone, cursor: page.continueCursor };
  },
});

export const userCount = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query('users').collect()).length,
});
