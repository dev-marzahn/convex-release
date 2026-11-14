import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// v2: `body` is renamed to `text` (0001).
export default defineSchema({
  messages: defineTable({ text: v.string(), author: v.string() }).index('by_author', ['author']),
});
