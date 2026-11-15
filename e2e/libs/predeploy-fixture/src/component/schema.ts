import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // While any flag exists, the fixture's predeploy check refuses the release.
  flags: defineTable({ reason: v.string() }),
});
