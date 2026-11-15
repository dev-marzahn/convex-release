import { userByName } from '../users';
import { defineMigration } from './_generated';

// Uses the users table and its by_name index: both exist before migrations
// run, because the release pushes the new schema first.
export default defineMigration({
  table: 'messages',
  migrateOne: async (ctx, doc) => {
    if (typeof doc.author !== 'string') return;
    // e2e hook: the deployment env var FAIL_AT makes this fail on one author.
    if (process.env.FAIL_AT && doc.author === process.env.FAIL_AT) throw new Error(`FAIL_AT reached at ${doc.author}`);
    return { authorId: await userByName(ctx, doc.author), author: undefined };
  },
});
