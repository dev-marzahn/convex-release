// `convex-release bundle <outDir>`: the push requests a release image applies.
//
// Uses the project's own `convex` CLI with `--write-push-request`, which writes
// the complete request (every module's source, the schema, components) and
// stops before contacting any server. Writes:
//   push.json:          the app as it is;
//   push.relaxed.json:  the same code with schema validation off, only when
//                       there are migrations to run between the two pushes;
//   checks/*.mjs:       the dependencies' predeploy check modules, which the
//                       image runs without the app's node_modules.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import pkg from '../package.json' with { type: 'json' };
import { writeGenerated } from './codegen.ts';
import { convexBin } from './convex-cli.ts';
import { assertSelfContained, collectAll, discoverChecks, type Log } from './predeploy.ts';
import type { Project } from './project.ts';
import { copyProject } from './relaxed.ts';
import { functionName } from './status.ts';

export interface BundleResult {
  modules: number;
  migrations: number;
  relaxed: boolean;
  /** Predeploy checks bundled. */
  checks: number;
}

/** `release.json`: what the entrypoint checks before it pushes anything. */
export interface ReleaseManifest {
  /**
   * The app's package.json `version`, absent when it has none. The images
   * record it on the deployment as `CONVEX_RELEASE_VERSION` once applied.
   */
  version?: string;
  /** Every migration this release knows, oldest first, as the component names them. */
  migrations: string[];
  /** Whether `seeds/_generated:run` exists, for `CONVEX_RELEASE_SEED`. */
  seeds: boolean;
  /**
   * The dependencies' predeploy checks, by package name. Absent when none is
   * declared. `module` is relative to release.json; `protocol` is for
   * readers, the runner reports the one that counts.
   */
  checks?: Record<string, { protocol: number; module: string; facts: unknown }>;
}

export interface BundleChecksOptions {
  runnerPath?: string;
  log?: Log;
}

/**
 * Collects each declared check's facts from the app's source and copies its
 * module into `<outDir>/checks`, after proving it loads with no node_modules
 * around it. Any failure fails the image build, not its start.
 */
export async function bundleChecks(project: Project, outDir: string, options: BundleChecksOptions = {}): Promise<ReleaseManifest['checks']> {
  const checksDir = join(outDir, 'checks');
  // Always, so a release that drops its last check leaves no stale module.
  rmSync(checksDir, { recursive: true, force: true });
  const declared = discoverChecks(project.root);
  if (declared.length === 0) return undefined;
  const host = { runnerPath: options.runnerPath, log: options.log ?? ((pkg: string, line: string) => console.log(`[${pkg}] ${line}`)) };
  const { collected, failed } = await collectAll(declared, { projectRoot: project.root, convexDir: project.functionsDir }, host);
  if (failed.length > 0) throw new Error(['Predeploy check collect failed:', ...failed.map((o) => `${o.packageName}: ${o.message}`)].join('\n'));
  mkdirSync(checksDir, { recursive: true });
  const checks: NonNullable<ReleaseManifest['checks']> = {};
  for (const check of collected) {
    const module = `checks/${check.packageName.replaceAll('/', '__')}.mjs`;
    copyFileSync(check.modulePath, join(outDir, module));
    await assertSelfContained({ packageName: check.packageName, modulePath: join(outDir, module) }, host);
    checks[check.packageName] = { protocol: check.protocol, module, facts: check.facts };
  }
  return checks;
}

/** Written by images/Dockerfile into every release image. */
export const IMAGE_PACKAGE_FILE = '/convex/release-package.json';

/**
 * In a release image, the app's convex-release writes the bundle and the
 * image's entrypoint applies it, so both have to be the same version.
 */
export function assertImageVersion(ownVersion: string, imagePackageFile = IMAGE_PACKAGE_FILE): void {
  if (!existsSync(imagePackageFile)) return;
  const image = (JSON.parse(readFileSync(imagePackageFile, 'utf8')) as { version: string }).version;
  if (image === ownVersion) return;
  throw new Error(
    `This image is convex-release ${image}, but the app has ${ownVersion} installed. Build FROM the ${ownVersion} image, or install @dev-marzahn/convex-release@${image}.`,
  );
}

export async function bundle(project: Project, outDir: string, options: BundleChecksOptions = {}): Promise<BundleResult> {
  assertImageVersion(pkg.version);
  const { migrations, seeds } = writeGenerated(project);
  mkdirSync(outDir, { recursive: true });
  const checks = await bundleChecks(project, outDir, options);
  const packageFile = join(project.root, 'package.json');
  const { version } = (existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8')) : {}) as { version?: unknown };
  const manifest: ReleaseManifest = {
    ...(typeof version === 'string' && version ? { version } : {}),
    migrations: migrations.map((m) => functionName(m.module)),
    seeds: (seeds?.length ?? 0) > 0,
    ...(checks ? { checks } : {}),
  };
  writeFileSync(join(outDir, 'release.json'), JSON.stringify(manifest));
  const checkCount = Object.keys(checks ?? {}).length;
  const copy = copyProject(project);
  try {
    // The copy is only bundled, never deployed: its deployment config would
    // compete with the placeholders below.
    for (const env of ['.env', '.env.local']) rmSync(join(copy.project.root, env), { force: true });
    const strict = writePushRequest(copy.project, join(outDir, 'push.json'));
    rmSync(join(outDir, 'push.relaxed.json'), { force: true });
    if (migrations.length === 0) return { modules: moduleCount(strict), migrations: 0, relaxed: false, checks: checkCount };
    copy.relaxSchema();
    const relaxedFile = join(outDir, 'push.relaxed.json');
    const relaxed = writePushRequest(copy.project, relaxedFile);
    // Pass 1 runs exactly pass 2's code: the strict request with only the
    // schema module swapped. Functions that import the schema (the seeds
    // wiring does) would otherwise be bundled with the relaxed wrapper.
    if (JSON.stringify(relaxed.appDefinition.schema) === JSON.stringify(strict.appDefinition.schema)) {
      throw new Error('Relaxing the schema changed nothing in the bundle.');
    }
    writeFileSync(relaxedFile, JSON.stringify({ ...strict, appDefinition: { ...strict.appDefinition, schema: relaxed.appDefinition.schema } }));
    return { modules: moduleCount(strict), migrations: migrations.length, relaxed: true, checks: checkCount };
  } finally {
    copy.dispose();
  }
}

type PushRequest = { adminKey?: string; appDefinition: { schema: unknown; changedModules: unknown[] } };

function writePushRequest(project: Project, outFile: string): PushRequest {
  const stem = outFile.replace(/\.json$/, '');
  const args = ['deploy', '-y', '--codegen', 'disable', '--typecheck', 'disable', '--push-all-modules', '--write-push-request', stem];
  const result = spawnSync(process.execPath, [convexBin(project), ...args], {
    cwd: project.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Placeholders: --write-push-request stops before any request is made.
      CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:9',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'bundle',
      CONVEX_DEPLOYMENT: '',
      CONVEX_DEPLOY_KEY: '',
    },
  });
  if (result.status !== 0) throw new Error(`Bundling failed:\n${`${result.stdout}\n${result.stderr}`.trim()}`);
  const request = JSON.parse(readFileSync(outFile, 'utf8')) as PushRequest;
  delete request.adminKey;
  writeFileSync(outFile, JSON.stringify(request));
  return request;
}

function moduleCount(request: PushRequest): number {
  return request.appDefinition.changedModules.length;
}
