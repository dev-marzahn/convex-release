// `convex-release new <name>`: the next numbered migration file.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { listMigrations } from './codegen.ts';
import type { Project } from './project.ts';

/** "Rename body to text" -> "rename_body_to_text". */
export function migrationSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`"${name}" has no letters or digits to name a migration after.`);
  return slug;
}

export function renderMigration(table: string): string {
  return `import { defineMigration } from "./_generated";

export default defineMigration({
  table: ${JSON.stringify(table)},
  migrateOne: async (ctx, doc) => {
    // Return the fields to change, or nothing to leave the document as it is.
    // A field set to undefined is removed. This can run more than once on the
    // same document, so check first whether it still needs the change:
    //
    //   if (doc.oldField === undefined) return;
    //   return { newField: doc.oldField, oldField: undefined };
  },
});
`;
}

export function createMigration(project: Project, name: string, table: string): string {
  const existing = listMigrations(project.migrationsDir);
  const next = existing.length === 0 ? 1 : existing.at(-1)!.number + 1;
  const file = `${String(next).padStart(4, '0')}_${migrationSlug(name)}.ts`;
  const path = join(project.migrationsDir, file);
  if (existsSync(path)) throw new Error(`${file} already exists.`);
  mkdirSync(project.migrationsDir, { recursive: true });
  writeFileSync(path, renderMigration(table));
  return path;
}
