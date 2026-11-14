import { userByName } from '../users';
import { defineMigration } from './_generated';

// Uses the users table and its by_name index: both exist before migrations
// run, because the release pushes the new schema first.
export default defineMigration({
  table: 'messages',
  migrateOne: async (ctx, doc) => {
    if (typeof doc.author !== 'string') return;
    return { authorId: await userByName(ctx, doc.author), author: undefined };
  },
});
