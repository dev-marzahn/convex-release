import { defineMigration } from './_generated';

export default defineMigration({
  table: 'messages',
  migrateOne: (_ctx, doc) => {
    if (typeof doc.body !== 'string') return;
    return { text: doc.body, body: undefined };
  },
});
