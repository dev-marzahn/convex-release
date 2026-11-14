import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// v3: every message stores its length (0002, which needs 0001's `text`).
export default defineSchema({
  messages: defineTable({ text: v.string(), length: v.number(), author: v.string() }).index('by_author', ['author']),
});
