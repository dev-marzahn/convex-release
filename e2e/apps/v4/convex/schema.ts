import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// v4: authors become documents (0003); the `author` field and its index are gone.
export default defineSchema({
  users: defineTable({ name: v.string() }).index('by_name', ['name']),
  messages: defineTable({ text: v.string(), length: v.number(), authorId: v.id('users') }).index('by_authorId', ['authorId']),
});
