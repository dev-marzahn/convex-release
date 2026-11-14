// `convex-release init`: everything a project needs, without overwriting.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { IMAGE } from './images.ts';
import type { Project } from './project.ts';

const PACKAGES = ['@dev-marzahn/convex-release', '@convex-dev/migrations'];

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

/** The lockfile's package manager, else the one running this command. */
export function detectPackageManager(root: string, userAgent = process.env.npm_config_user_agent ?? ''): PackageManager {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json'))) return 'npm';
  for (const pm of ['bun', 'pnpm', 'yarn'] as const) if (userAgent.startsWith(pm)) return pm;
  return 'npm';
}

export function missingPackages(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
  const have = { ...manifest.dependencies, ...manifest.devDependencies };
  return PACKAGES.filter((name) => !have[name]);
}

export function installPackages(root: string, pm: PackageManager, names: string[]): void {
  const args = pm === 'npm' ? ['install', ...names] : ['add', ...names];
  const result = spawnSync(pm, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`\`${pm} ${args.join(' ')}\` failed.`);
}

const CONVEX_CONFIG = `import migrations from "@convex-dev/migrations/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(migrations);
export default app;
`;

export type ConfigChange = 'created' | 'updated' | 'unchanged' | 'manual';

/** Mounts the migrations component in convex.config.ts. */
export function ensureConvexConfig(project: Project): ConfigChange {
  const path = ['convex.config.ts', 'convex.config.js'].map((f) => join(project.functionsDir, f)).find(existsSync);
  if (!path) {
    writeFileSync(join(project.functionsDir, 'convex.config.ts'), CONVEX_CONFIG);
    return 'created';
  }
  const source = readFileSync(path, 'utf8');
  if (source.includes('@convex-dev/migrations/convex.config')) return 'unchanged';
  const app = /const\s+(\w+)\s*=\s*defineApp\(\s*\)\s*;?/.exec(source);
  if (!app) return 'manual';
  const withUse = source.replace(app[0], `${app[0]}\n${app[1]}.use(migrations);`);
  writeFileSync(path, `import migrations from "@convex-dev/migrations/convex.config";\n${withUse}`);
  return 'updated';
}

export function dockerFiles(project: Project): Record<string, string> {
  const name = (JSON.parse(readFileSync(join(project.root, 'package.json'), 'utf8')) as { name?: string }).name ?? 'app';
  const slug = name
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9-]+/gi, '-')
    .toLowerCase();
  return {
    Dockerfile: `# Builds this app's release image: the Convex backend plus this app's
# functions and migrations, applied when the container starts.
FROM ${IMAGE}
`,
    '.dockerignore': `node_modules
.git
.env*
`,
    'compose.yaml': `# Run the release image. Upgrading means changing the tag and running
# \`docker compose up -d\`: migrations run before it reports healthy.
services:
  ${slug}:
    build: .
    image: ${slug}:latest
    ports:
      - "3210:3210" # Convex API
      - "3211:3211" # HTTP actions
    environment:
      INSTANCE_NAME: ${slug.replace(/-/g, '_')}
      # Generate once and keep it: openssl rand -hex 32
      INSTANCE_SECRET: \${INSTANCE_SECRET:?set INSTANCE_SECRET}
    volumes:
      - data:/convex/data
    restart: unless-stopped

volumes:
  data:
`,
  };
}

/** Writes the Docker files that don't exist yet; returns their names. */
export function writeDockerFiles(project: Project): string[] {
  const written: string[] = [];
  for (const [file, content] of Object.entries(dockerFiles(project))) {
    const path = join(project.root, file);
    if (existsSync(path)) continue;
    writeFileSync(path, content);
    written.push(file);
  }
  return written;
}
