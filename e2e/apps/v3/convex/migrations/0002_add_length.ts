import { defineMigration } from './_generated';

// Runs after 0001, so every message has `text` by now.
export default defineMigration({
  table: 'messages',
  migrateOne: (_ctx, doc) => {
    if (doc.length !== undefined || doc.text === undefined) return;
    return { length: doc.text.length };
  },
});
