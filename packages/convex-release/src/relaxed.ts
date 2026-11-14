// A temporary copy of the project whose schema has validation off, for the
// first push of a release: the code and indexes switch over, existing
// documents aren't checked until the migrations have run.
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import type { Project } from './project.ts';

export interface ProjectCopy {
  project: Project;
  /** Switches the copy's schema to validation off. */
  relaxSchema(): void;
  dispose(): void;
}

/** Not copied: build output and history the push doesn't need. */
const SKIP = new Set(['.git', 'dist', 'out']);
/**
 * Shared with the project instead of copied: installed packages, and `.convex/`,
 * where local deployments keep their state. A copy of that would be a second
 * deployment.
 */
const SHARE = new Set(['node_modules', '.convex']);

export function copyProject(project: Project): ProjectCopy {
  const root = mkdtempSync(join(tmpdir(), 'convex-release-'));
  cpSync(project.root, root, {
    recursive: true,
    filter: (src) => {
      const rel = relative(project.root, src);
      const top = rel.split(sep)[0]!;
      return rel === '' || !(SKIP.has(top) || SHARE.has(top));
    },
  });
  for (const name of SHARE) {
    if (existsSync(join(project.root, name))) symlinkSync(join(project.root, name), join(root, name), 'dir');
  }
  const functionsDir = join(root, project.functionsPath);
  const copy: Project = {
    root,
    functionsDir,
    functionsPath: project.functionsPath,
    migrationsDir: join(functionsDir, 'migrations'),
  };
  return {
    project: copy,
    relaxSchema: () => relaxSchema(copy),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Renames schema.ts to schema.strict.ts and puts a schema.ts in its place that
 * re-exports it with validation off. The CLI bundles two-dot files only when
 * imported, so the copy's code is otherwise exactly the app's.
 */
function relaxSchema(project: Project) {
  const ext = ['.ts', '.js'].find((e) => existsSync(join(project.functionsDir, `schema${e}`)));
  if (!ext) return;
  renameSync(join(project.functionsDir, `schema${ext}`), join(project.functionsDir, `schema.strict${ext}`));
  const target = ext === '.ts' ? '(schema as { schemaValidation: boolean })' : 'schema';
  writeFileSync(
    join(project.functionsDir, `schema${ext}`),
    `import schema from "./schema.strict";\n${target}.schemaValidation = false;\nexport default schema;\n`,
  );
}
