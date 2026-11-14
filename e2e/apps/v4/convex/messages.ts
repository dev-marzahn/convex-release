import { v } from 'convex/values';

import { internalQuery, mutation, query } from './_generated/server';
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

/** Test helper for `test-upgrade --check`: throws unless `count` messages and `users` users were migrated. */
export const verifyInternal = internalQuery({
  args: { count: v.number(), users: v.number() },
  handler: async (ctx, { count, users }) => {
    const messages = await ctx.db.query('messages').collect();
    const migrated = messages.filter((m) => m.length === m.text.length && (m as unknown as Record<string, unknown>).author === undefined);
    const userTotal = (await ctx.db.query('users').collect()).length;
    if (migrated.length !== count || userTotal !== users) {
      throw new Error(`expected ${count} migrated messages and ${users} users, got ${migrated.length} and ${userTotal}`);
    }
  },
});
