// Where things live in a Convex project.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Project {
  /** The project root: where package.json and convex.json are. */
  root: string;
  /** The functions folder, `convex/` unless convex.json says otherwise. */
  functionsDir: string;
  /** The functions folder relative to the root, as convex.json spells it. */
  functionsPath: string;
  /** `<functions>/migrations`. */
  migrationsDir: string;
}

export function findProject(root = process.cwd()): Project {
  const absRoot = resolve(root);
  let functionsPath = 'convex';
  const convexJson = join(absRoot, 'convex.json');
  if (existsSync(convexJson)) {
    const config = JSON.parse(readFileSync(convexJson, 'utf8')) as { functions?: unknown };
    if (typeof config.functions === 'string') functionsPath = config.functions.replace(/\/+$/, '');
  }
  const functionsDir = join(absRoot, functionsPath);
  return {
    root: absRoot,
    functionsDir,
    functionsPath,
    migrationsDir: join(functionsDir, 'migrations'),
  };
}
