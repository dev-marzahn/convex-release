#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import * as p from '@clack/prompts';
import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { bundle } from './bundle.ts';
import { check } from './check.ts';
import { writeWorkflows, type DeployWith } from './ci.ts';
import { listSeeds, writeGenerated } from './codegen.ts';
import { runInteractive } from './convex-cli.ts';
import { build, testUpgrade } from './docker.ts';
import { appImageName } from './images.ts';
import { detectPackageManager, ensureConvexConfig, installPackages, missingPackages, writeDockerFiles } from './init.ts';
import { createMigration, createSeed } from './new.ts';
import { findProject, type Project } from './project.ts';
import { checkTarget, deployTarget, devTarget, MigrationTimeout, release, runSeeds, SEED, type ReleaseTarget } from './release.ts';
import type { SeedResult } from './seed.ts';
import { readStatus } from './status.ts';
import { interactive, jobSummary, migrationsMarkdown, progress, requireAnswer } from './ui.ts';
import { defaultBase, repoPath, verify } from './verify.ts';

const program = new Command('convex-release').description('Data migrations and self-hosted Docker releases for Convex apps.').version(pkg.version);

const label = (name: string) => name.replace(/^migrations\//, '');
const seconds = (value: string | undefined) => (value === undefined ? undefined : Number(value) * 1000);

program
  .command('dev')
  .description('Deploy to your dev deployment (code, then pending migrations), then keep watching like `convex dev`.')
  .option('--once', 'deploy once and exit instead of watching')
  .option('--timeout <seconds>', 'stop waiting for migrations after this long')
  .allowUnknownOption()
  .argument('[convexDevArgs...]', 'passed on to `convex dev`')
  .action(async (convexDevArgs: string[], options: { once?: boolean; timeout?: string }) => {
    const project = findProject();
    await runRelease(project, devTarget, seconds(options.timeout));
    if (listSeeds(project.seedsDir).length > 0) {
      const result = runSeeds(project, devTarget.runArgs);
      if (result.seeded) p.log.success(`Seeded the empty deployment: ${seedSummary(result)}`);
    }
    if (options.once) return;
    p.log.info('Handing over to `convex dev`');
    process.exit(runInteractive(project, ['dev', ...convexDevArgs]));
  });

program
  .command('deploy')
  .description('Deploy code and pending migrations to the deployment `convex deploy` targets: prod, a deploy key, or a self-hosted URL.')
  .option('--deployment <name>', 'a specific deployment, as `convex deploy` takes it')
  .option('--timeout <seconds>', 'stop waiting for migrations after this long; they keep running on the deployment')
  .action(async (options: { deployment?: string; timeout?: string }) => {
    const project = findProject();
    await runRelease(project, deployTarget(project, options.deployment), seconds(options.timeout));
  });

program
  .command('init')
  .description('Set up migrations (and optionally a Docker image) in this Convex project.')
  .option('--docker', 'also write Dockerfile, .dockerignore and compose.yaml')
  .option('--no-docker', "don't ask about Docker files")
  .option('--no-install', "don't install missing packages")
  .option('--ci', 'also write GitHub Actions workflows (verify on pull requests, and deploy on push or an image on tags)')
  .option('--no-ci', "don't ask about workflows")
  .option('--deploy-with <how>', 'for --ci: `image` (images deploy; needs a Dockerfile) or `cli` (`convex-release deploy` on push)')
  .action(async (options: { docker?: boolean; install: boolean; ci?: boolean; deployWith?: string }) => {
    const project = findProject();
    p.intro('convex-release init');
    if (!existsSync(join(project.root, 'package.json'))) throw new Error('No package.json here. Run this in your Convex project.');
    mkdirSync(project.functionsDir, { recursive: true });

    const pm = detectPackageManager(project.root);
    const missing = missingPackages(project.root, pm);
    if (missing.length > 0 && options.install) {
      p.log.step(`Installing ${missing.join(', ')} with ${pm}`);
      installPackages(project.root, pm, missing);
    } else if (missing.length > 0) {
      p.log.warn(`Install ${missing.join(' and ')} yourself.`);
    }

    const config = ensureConvexConfig(project);
    const configFile = `${project.functionsPath}/convex.config.ts`;
    if (config === 'manual') {
      p.log.warn(
        `Couldn't find \`defineApp()\` in ${configFile}. Add:\n  import migrations from "@convex-dev/migrations/convex.config";\n  app.use(migrations);`,
      );
    } else if (config !== 'unchanged') {
      p.log.success(`${config === 'created' ? 'Created' : 'Updated'} ${configFile}: mounts the migrations component`);
    }

    writeGenerated(project);
    p.log.success(`Wrote ${relative(project.root, project.migrationsDir)}/_generated.ts`);

    let docker = options.docker;
    if (docker === undefined && interactive) {
      const answer = await p.confirm({ message: 'Also set up a Docker image (Dockerfile, compose.yaml)?', initialValue: true });
      docker = !p.isCancel(answer) && answer;
    }
    if (docker) {
      const written = writeDockerFiles(project);
      if (written.length > 0) p.log.success(`Wrote ${written.join(', ')}`);
      else p.log.info('Docker files already exist; left them as they are.');
    }

    let ci = options.ci;
    if (ci === undefined && interactive) {
      const answer = await p.confirm({ message: 'Also write GitHub Actions workflows?', initialValue: true });
      ci = !p.isCancel(answer) && answer;
    }
    if (ci) {
      const deployWith = await chooseDeployWith(existsSync(join(project.root, 'Dockerfile')), options.deployWith);
      const written = writeWorkflows(project, pm, deployWith);
      const secrets = deployWith === 'cli' ? ' Add the CONVEX_DEPLOY_KEY secret (or the self-hosted ones) before the first deploy.' : '';
      if (written.length > 0) p.log.success(`Wrote ${written.join(', ')}.${secrets}`);
      else p.log.info('The workflows already exist; left them as they are.');
    }

    p.outro('Next: `convex-release new "what it does"` for a migration, `convex-release dev` instead of `convex dev`.');
  });

program
  .command('status')
  .description('Show each migration as the deployment has recorded it (dev by default).')
  .option('--prod', "the project's production deployment")
  .option('--deployment <name>', 'a specific deployment')
  .option('--json', 'print the rows as JSON')
  .action((options: { prod?: boolean; deployment?: string; json?: boolean }) => {
    const project = findProject();
    const runArgs = options.deployment ? ['--deployment', options.deployment] : options.prod ? ['--prod'] : [];
    const rows = readStatus(project, runArgs);
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    jobSummary(migrationsMarkdown('Migrations', rows));
    if (rows.length === 0) {
      p.log.info('No migrations yet. Create one with `convex-release new`.');
      return;
    }
    const icon: Record<string, string> = { done: '✔', running: '…', pending: '○', failed: '✖', canceled: '✖' };
    const width = Math.max(...rows.map((r) => label(r.name).length));
    const lines = rows.map((r) => {
      const unknown = r.state === 'done' ? '  not in this checkout: from a newer version' : '  not in this checkout: renamed or deleted';
      const detail = r.unknown ? unknown : r.error ? `  ${r.error.split('\n')[0]}` : '';
      return `${icon[r.state]} ${label(r.name).padEnd(width)}  ${r.state.padEnd(8)} ${String(r.processed).padStart(7)} docs${detail}`;
    });
    p.note(lines.join('\n'), 'Migrations');
  });

program
  .command('check')
  .description("Check whether this checkout's schema accepts the deployment's data, without changing anything (dev by default).")
  .option('--prod', "the project's production deployment")
  .option('--deployment <name>', 'a specific deployment')
  .option('--json', 'print the result as JSON')
  .addHelpText('after', "\nExit code 1 when the data doesn't match and no pending migration could change that; 0 otherwise.")
  .action((options: { prod?: boolean; deployment?: string; json?: boolean }) => {
    const project = findProject();
    const ui = options.json ? undefined : progress();
    ui?.step('Validating the schema against the data (dry run)');
    const result = check(project, checkTarget(project, options));
    const needsMigration = !result.matches && result.pending.length === 0;
    if (options.json) {
      console.log(JSON.stringify({ ...result, needsMigration }, null, 2));
      if (needsMigration) process.exit(1);
      return;
    }
    if (result.matches) {
      ui?.done('The schema accepts the data as it is.');
      if (result.pending.length > 0) p.log.info(`Pending migrations still run on deploy:${result.pending.map(label).join(', ')}`);
      return;
    }
    const where = result.mismatch?.table ? `\`${result.mismatch.table}\`` : 'a table';
    ui?.fail(`Documents in ${where} don't match the schema: ${result.mismatch?.message}`);
    if (needsMigration) {
      p.log.warn(`No migration is pending. Write one: convex-release new "what it changes" --table ${result.mismatch?.table ?? '<table>'}`);
      process.exit(1);
    }
    p.log.warn(`Pending migrations run before the strict push: ${result.pending.map(label).join(', ')}. If they change ${where}, the deploy will pass.`);
  });

program
  .command('verify')
  .description('Compare the migrations with a base branch: shipped ones must stay, keep their numbers, and come before new ones. Needs no deployment.')
  .option('--base <ref>', 'the git ref to compare with (default: the pull request target, else origin/main)')
  .option('--json', 'print the issues as JSON')
  .addHelpText('after', '\nExit code 1 on errors; warnings (an edited shipped migration) keep it 0.')
  .action((options: { base?: string; json?: boolean }) => {
    const project = findProject();
    const base = options.base ?? defaultBase();
    const issues = verify(project, base);
    const errors = issues.filter((i) => i.level === 'error');
    if (options.json) {
      console.log(JSON.stringify({ base, issues }, null, 2));
    } else {
      if (process.env.GITHUB_ACTIONS) {
        for (const i of issues) console.log(`::${i.level} file=${repoPath(project, i.migration)},title=convex-release verify::${i.migration} ${i.message}`);
      }
      for (const i of issues) (i.level === 'error' ? p.log.error : p.log.warn)(`${i.migration} ${i.message}`);
      if (issues.length === 0) p.log.success(`Migrations are consistent with ${base}.`);
    }
    if (errors.length > 0) process.exit(1);
  });

program
  .command('new')
  .description('Create the next numbered migration, or with --seed the next seed file.')
  .argument('[name]', 'what it does, e.g. "rename body to text"')
  .option('-t, --table <table>', 'the table it migrates or seeds')
  .option('--seed', 'create a seed in convex/seeds/ instead of a migration')
  .action(async (nameArg: string | undefined, options: { table?: string; seed?: boolean }) => {
    const project = findProject();
    const kind = options.seed ? 'seed' : 'migration';
    const name =
      requireAnswer(nameArg, `the ${kind} name`) ??
      (await ask(options.seed ? 'What does the seed add?' : 'What does the migration do?', options.seed ? 'users' : 'rename body to text'));
    const table =
      requireAnswer(options.table, '--table') ?? (await ask(`Which table does it ${options.seed ? 'seed' : 'migrate'}?`, options.seed ? 'users' : 'messages'));
    const path = options.seed ? createSeed(project, name, table) : createMigration(project, name, table);
    writeGenerated(project);
    p.log.success(`Created ${relative(project.root, path)}`);
  });

program
  .command('seed')
  .description('Run the seeds in convex/seeds/ on a deployment without data (dev by default).')
  .option('--prod', "the project's production deployment")
  .option('--deployment <name>', 'a specific deployment')
  .option('--force', 'seed even if the deployment already has data')
  .option('--json', 'print the result as JSON')
  .action((options: { prod?: boolean; deployment?: string; force?: boolean; json?: boolean }) => {
    const project = findProject();
    if (listSeeds(project.seedsDir).length === 0) throw new Error('No seeds yet. Create one with `convex-release new users --seed --table users`.');
    const runArgs = options.deployment ? ['--deployment', options.deployment] : options.prod ? ['--prod'] : [];
    const result = runSeeds(project, runArgs, options.force);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.seeded) p.log.success(`Seeded: ${seedSummary(result)}`);
    else p.log.info(`Nothing seeded: ${result.reason}. \`--force\` seeds anyway.`);
  });

program
  .command('codegen')
  .description('Regenerate migrations/_generated.ts and seeds/_generated.ts from the migration and seed files.')
  .action(() => {
    const project = findProject();
    const { changed, migrations } = writeGenerated(project);
    const where = relative(project.root, project.migrationsDir);
    p.log.success(`${changed ? 'Wrote' : 'Up to date:'} ${where}/_generated.ts (${migrations.length} migration${migrations.length === 1 ? '' : 's'})`);
  });

program
  .command('bundle')
  .description('Write the push requests an image applies (run by the image build).')
  .argument('[outDir]', 'where to write push.json and push.relaxed.json', '.convex-release')
  .action((outDir: string) => {
    const project = findProject();
    const result = bundle(project, resolve(outDir));
    p.log.success(
      `Bundled ${result.modules} modules${result.relaxed ? ` and ${result.migrations} migration${result.migrations === 1 ? '' : 's'} (two passes)` : ' (no migrations: one pass)'}`,
    );
  });

program
  .command('build')
  .description('Build the image, tagged <name>:<version> from package.json (<name>-oneshot:<version> with --oneshot).')
  .option('-t, --tag <tag>', 'the image tag (default from package.json)')
  .option('--oneshot', 'build the one-shot image (deploys to a separate backend) instead')
  .action((options: { tag?: string; oneshot?: boolean }) => {
    const project = findProject();
    const tag = options.tag ?? appImageName(project, options.oneshot ? '-oneshot' : '');
    p.log.step(`Building ${tag}`);
    build(project, { tag, oneshot: options.oneshot });
    p.log.success(`Built ${tag}`);
  });

program
  .command('test-upgrade')
  .description('Check that the new version upgrades data from a previous one: starts --from, then --to on the same volume.')
  .requiredOption('--from <image>', 'the version users run today, e.g. my-app:1.3.0')
  .option('--to <image>', 'the new version (default: build this project first)')
  .option('--seed [function]', 'create data on --from: its own seeds, or a function such as testing:seed')
  .option('--check <function>', 'a function to run on --to afterwards; it should throw if the data is wrong')
  .option('--snapshot <zip>', 'a `convex export` zip to import into --from first: a rehearsal on a copy of real data')
  .option('--timeout <seconds>', 'how long each version may take to become ready', '600')
  .action(async (options: { from: string; to?: string; seed?: string | true; check?: string; snapshot?: string; timeout: string }) => {
    const project = findProject();
    const seed = options.seed === true ? `${SEED} {"force": true}` : options.seed;
    let to = options.to;
    if (!to) {
      to = appImageName(project);
      p.log.step(`Building ${to}`);
      build(project, { tag: to });
    }
    const ui = progress();
    let current = '';
    let result;
    try {
      result = await testUpgrade(
        { from: options.from, to, seed, check: options.check, snapshot: options.snapshot, project, timeoutMs: seconds(options.timeout) },
        {
          step: (message) => {
            current = message;
            ui.step(message);
          },
          log: (line) => ui.update(`${current}: ${line}`),
        },
      );
    } catch (err) {
      ui.fail();
      throw err;
    }
    const took = `${Math.round(result.upgradeMs / 1000)}s`;
    ui.done(`${options.from} upgrades to ${to} in ${took}`);
    jobSummary(
      [
        `### Upgrade test: \`${options.from}\` → \`${to}\``,
        '',
        `Ready after ${took}${options.snapshot ? `, on a copy of \`${options.snapshot}\`` : ''}.`,
        '',
        '```',
        ...result.log,
        '```',
        '',
      ].join('\n'),
    );
  });

async function runRelease(project: Project, target: ReleaseTarget, timeoutMs?: number) {
  const ui = progress();
  let result;
  try {
    result = await release(project, target, { step: ui.step, progress: (s) => ui.update(`Running migrations: ${s.message ?? s.state}`) }, { timeoutMs });
  } catch (err) {
    ui.fail();
    summarize(project, target, err instanceof MigrationTimeout ? 'Deploy still running: migrations continue on the deployment' : 'Deploy failed');
    throw err;
  }
  if (result.state !== 'done') {
    ui.fail(result.message ?? 'Migrations failed');
    summarize(project, target, 'Deploy failed');
    process.exit(1);
  }
  ui.done();
  summarize(project, target, 'Deployed');
  p.log.success('Deployed: code live, data matches the schema.');
}

/** The migrations table for the GitHub Actions job summary. Best effort. */
function summarize(project: Project, target: ReleaseTarget, title: string) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    jobSummary(migrationsMarkdown(title, readStatus(project, target.runArgs)));
  } catch {
    jobSummary(`### ${title}\n`);
  }
}

/**
 * Images or `convex-release deploy`, never both: each would push its own
 * version. Without a Dockerfile only `cli` is possible; outside a terminal a
 * Dockerfile means images.
 */
async function chooseDeployWith(hasDockerfile: boolean, flag: string | undefined): Promise<DeployWith> {
  if (flag !== undefined && flag !== 'image' && flag !== 'cli') throw new Error(`--deploy-with takes \`image\` or \`cli\`, not \`${flag}\`.`);
  if (flag === 'image' && !hasDockerfile) throw new Error('--deploy-with image needs a Dockerfile. Add `--docker`, or use `--deploy-with cli`.');
  if (flag) return flag;
  if (!hasDockerfile) return 'cli';
  if (!interactive) return 'image';
  const answer = await p.select({
    message: 'How does this app deploy?',
    options: [
      { value: 'image' as const, label: 'Images', hint: 'tags build and push an image; it deploys when it starts' },
      { value: 'cli' as const, label: 'convex-release deploy', hint: 'pushes to your default branch deploy' },
    ],
  });
  if (p.isCancel(answer)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
  return answer;
}

function seedSummary(result: SeedResult): string {
  return result.seeds.map((s) => `${s.name.replace(/^seeds\//, '')} (${s.documents} doc${s.documents === 1 ? '' : 's'})`).join(', ') || 'no seeds';
}

async function ask(message: string, placeholder: string): Promise<string> {
  const answer = await p.text({ message, placeholder, validate: (v) => (v?.trim() ? undefined : 'Required') });
  if (p.isCancel(answer)) {
    p.cancel('Cancelled.');
    process.exit(1);
  }
  return answer;
}

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof Error) {
    p.log.error(err.message);
    process.exit(1);
  }
  throw err;
}
