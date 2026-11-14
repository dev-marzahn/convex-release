// `convex-release bundle <outDir>`: the push requests a release image applies.
//
// Uses the project's own `convex` CLI with `--write-push-request`, which writes
// the complete request (every module's source, the schema, components) and
// stops before contacting any server. Writes:
//   push.json:          the app as it is;
//   push.relaxed.json:  the same code with schema validation off, only when
//                       there are migrations to run between the two pushes.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeGenerated } from './codegen.ts';
import { convexBin } from './convex-cli.ts';
import type { Project } from './project.ts';
import { copyProject } from './relaxed.ts';

export interface BundleResult {
  modules: number;
  migrations: number;
  relaxed: boolean;
}

export function bundle(project: Project, outDir: string): BundleResult {
  const { migrations } = writeGenerated(project);
  mkdirSync(outDir, { recursive: true });
  // Both requests come from one copy: esbuild names shared chunks by path, so
  // two directories would give the same code different chunk names.
  const copy = copyProject(project);
  try {
    // The copy is only bundled, never deployed: its deployment config would
    // compete with the placeholders below.
    for (const env of ['.env', '.env.local']) rmSync(join(copy.project.root, env), { force: true });
    const strict = writePushRequest(copy.project, join(outDir, 'push.json'));
    rmSync(join(outDir, 'push.relaxed.json'), { force: true });
    if (migrations.length === 0) return { modules: moduleCount(strict), migrations: 0, relaxed: false };
    copy.relaxSchema();
    const relaxed = writePushRequest(copy.project, join(outDir, 'push.relaxed.json'));
    assertOnlySchemaDiffers(strict, relaxed);
    return { modules: moduleCount(strict), migrations: migrations.length, relaxed: true };
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

/** Pass 1 must run exactly the code pass 2 runs; only the schema may differ. */
function assertOnlySchemaDiffers(strict: PushRequest, relaxed: PushRequest) {
  const strip = (r: PushRequest) => JSON.stringify({ ...r, appDefinition: { ...r.appDefinition, schema: null } });
  if (strip(strict) !== strip(relaxed)) throw new Error('The validation-off bundle differs from the strict one outside schema.js.');
}
