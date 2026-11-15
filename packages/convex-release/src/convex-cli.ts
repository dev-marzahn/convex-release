// Runs the project's own `convex` CLI, so every deployment kind it supports
// (cloud dev/prod, preview, local, self-hosted) and its config files work as
// they do for the app.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Project } from './project.ts';

export class ConvexCliError extends Error {
  /** The CLI's stderr and stdout, when it ran and failed. */
  public readonly output: string;

  public constructor(message: string, output = '') {
    super(message);
    this.output = output;
  }
}

/** The function isn't deployed on that deployment. */
export class FunctionNotFound extends ConvexCliError {}

/** The project's installed `convex` CLI. */
export function convexBin(project: Project): string {
  try {
    const require = createRequire(join(project.root, 'package.json'));
    const pkg = require.resolve('convex/package.json');
    return join(dirname(pkg), 'bin', 'main.js');
  } catch {
    throw new ConvexCliError("The `convex` package isn't installed in this project.");
  }
}

/** Runs `convex <args>` attached to this terminal and returns its exit code. */
export function runInteractive(project: Project, args: string[]): number {
  const result = spawnSync(process.execPath, [convexBin(project), ...args], { cwd: project.root, stdio: 'inherit' });
  return result.status ?? 1;
}

export type PushTarget = { kind: 'dev' } | { kind: 'deploy'; args: string[] };

/**
 * Pushes the project's code: `convex dev --once` for the dev deployment, or
 * `convex deploy` for `--prod` / `--deployment`. The CLI's output is shown
 * only when it fails. `typecheck` keeps the CLI's default type check.
 */
export function push(project: Project, target: PushTarget, extra: string[] = [], { typecheck = false } = {}): void {
  const check = typecheck ? [] : ['--typecheck', 'disable'];
  const args = target.kind === 'dev' ? ['dev', '--once', ...check, ...extra] : ['deploy', '-y', ...check, ...target.args, ...extra];
  const result = spawnSync(process.execPath, [convexBin(project), ...args], {
    cwd: project.root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new ConvexCliError(`\`convex ${args[0]}\` failed:\n${`${result.stdout}\n${result.stderr}`.trim()}`);
  }
}

/** `convex run <fn> <args>` and the function's return value. */
export function runFunction<T>(project: Project, fn: string, convexArgs: string[] = [], args: object = {}): T {
  const result = spawnSync(process.execPath, [convexBin(project), 'run', fn, JSON.stringify(args), ...convexArgs], {
    cwd: project.root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw runError(fn, `${result.stderr}\n${result.stdout}`);
  return parseRunOutput<T>(result.stdout);
}

/**
 * `runFunction` without blocking: the caller's event loop keeps running
 * while the CLI does. `componentPath` targets a mounted component.
 */
export function runFunctionAsync<T>(project: Project, fn: string, convexArgs: string[] = [], args: object = {}, componentPath?: string): Promise<T> {
  const component = componentPath === undefined ? [] : ['--component', componentPath];
  const child = spawn(process.execPath, [convexBin(project), 'run', fn, JSON.stringify(args), ...component, ...convexArgs], { cwd: project.root });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new ConvexCliError(`convex run ${fn} failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(runError(fn, `${stderr}\n${stdout}`));
      try {
        resolve(parseRunOutput<T>(stdout));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function runError(fn: string, output: string): ConvexCliError {
  if (/Could not find function|is not a function|Could not find public function/i.test(output)) {
    return new FunctionNotFound(`${fn} isn't deployed yet. Push your code first (\`npx convex dev\`), then run this again.`, output);
  }
  return new ConvexCliError(output.trim() || `convex run ${fn} failed`, output);
}

function parseRunOutput<T>(stdout: string): T {
  const text = stdout.trim();
  return (text ? JSON.parse(text) : null) as T;
}
