import type { MutationCtx } from './_generated/server';

export async function userByName(ctx: MutationCtx, name: string) {
  const user = await ctx.db
    .query('users')
    .withIndex('by_name', (q) => q.eq('name', name))
    .unique();
  return user?._id ?? (await ctx.db.insert('users', { name }));
}
