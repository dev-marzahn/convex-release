import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// The current shape. Older releases stored `body` instead of `text`, had no
// `length`, and kept the author's name as a string on each message; the
// numbered files in migrations/ move existing data to this shape.
export default defineSchema({
  users: defineTable({ name: v.string() }).index('by_name', ['name']),
  messages: defineTable({
    text: v.string(),
    length: v.number(),
    authorId: v.id('users'),
  }).index('by_authorId', ['authorId']),
});
