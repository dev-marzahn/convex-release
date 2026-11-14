#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import * as p from '@clack/prompts';
import { Command } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { bundle } from './bundle.ts';
import { writeGenerated } from './codegen.ts';
import { runInteractive } from './convex-cli.ts';
import { build, testUpgrade } from './docker.ts';
import { appImageName } from './images.ts';
import { detectPackageManager, ensureConvexConfig, installPackages, missingPackages, writeDockerFiles } from './init.ts';
import { createMigration } from './new.ts';
import { findProject, type Project } from './project.ts';
import { deployTarget, devTarget, release, type ReleaseTarget } from './release.ts';
import { readStatus } from './status.ts';

const program = new Command('convex-release').description('Data migrations and self-hosted Docker releases for Convex apps.').version(pkg.version);

program
  .command('dev')
  .description('Release to your dev deployment (code, then pending migrations), then keep watching like `convex dev`.')
  .option('--once', 'release once and exit instead of watching')
  .allowUnknownOption()
  .argument('[convexDevArgs...]', 'passed on to `convex dev`')
  .action(async (convexDevArgs: string[], options: { once?: boolean }) => {
    const project = findProject();
    await runRelease(project, devTarget);
    if (options.once) return;
    p.log.info('Handing over to `convex dev`');
    process.exit(runInteractive(project, ['dev', ...convexDevArgs]));
  });

program
  .command('deploy')
  .description('Release to the deployment `convex deploy` targets: prod, a deploy key, or a self-hosted URL.')
  .option('--deployment <name>', 'a specific deployment, as `convex deploy` takes it')
  .action(async (options: { deployment?: string }) => {
    const project = findProject();
    await runRelease(project, deployTarget(project, options.deployment));
  });

program
  .command('init')
  .description('Set up migrations (and optionally a release image) in this Convex project.')
  .option('--docker', 'also write Dockerfile, .dockerignore and compose.yaml')
  .option('--no-docker', "don't ask about Docker files")
  .option('--no-install', "don't install missing packages")
  .action(async (options: { docker?: boolean; install: boolean }) => {
    const project = findProject();
    p.intro('convex-release init');
    if (!existsSync(join(project.root, 'package.json'))) throw new Error('No package.json here. Run this in your Convex project.');
    mkdirSync(project.functionsDir, { recursive: true });

    const missing = missingPackages(project.root);
    if (missing.length > 0 && options.install) {
      const pm = detectPackageManager(project.root);
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
    if (docker === undefined) {
      const answer = await p.confirm({ message: 'Also set up a Docker release image (Dockerfile, compose.yaml)?', initialValue: true });
      docker = !p.isCancel(answer) && answer;
    }
    if (docker) {
      const written = writeDockerFiles(project);
      if (written.length > 0) p.log.success(`Wrote ${written.join(', ')}`);
      else p.log.info('Docker files already exist; left them as they are.');
    }

    p.outro('Next: `convex-release new "what it does"` for a migration, `convex-release dev` instead of `convex dev`.');
  });

program
  .command('status')
  .description('Show each migration as the deployment has recorded it (dev by default).')
  .option('--prod', "the project's production deployment")
  .option('--deployment <name>', 'a specific deployment')
  .action((options: { prod?: boolean; deployment?: string }) => {
    const project = findProject();
    const runArgs = options.deployment ? ['--deployment', options.deployment] : options.prod ? ['--prod'] : [];
    const rows = readStatus(project, runArgs);
    if (rows.length === 0) {
      p.log.info('No migrations yet. Create one with `convex-release new`.');
      return;
    }
    const icon: Record<string, string> = { done: '✔', running: '…', pending: '○', failed: '✖', canceled: '✖' };
    const label = (name: string) => name.replace(/^migrations\//, '');
    const width = Math.max(...rows.map((r) => label(r.name).length));
    const lines = rows.map((r) => {
      const detail = r.unknown ? '  not in this checkout: from a newer release' : r.error ? `  ${r.error.split('\n')[0]}` : '';
      return `${icon[r.state]} ${label(r.name).padEnd(width)}  ${r.state.padEnd(8)} ${String(r.processed).padStart(7)} docs${detail}`;
    });
    p.note(lines.join('\n'), 'Migrations');
  });

program
  .command('new')
  .description('Create the next numbered migration.')
  .argument('[name]', 'what it does, e.g. "rename body to text"')
  .option('-t, --table <table>', 'the table it migrates')
  .action(async (nameArg: string | undefined, options: { table?: string }) => {
    const project = findProject();
    const name = nameArg ?? (await ask('What does the migration do?', 'rename body to text'));
    const table = options.table ?? (await ask('Which table does it migrate?', 'messages'));
    const path = createMigration(project, name, table);
    writeGenerated(project);
    p.log.success(`Created ${relative(project.root, path)}`);
  });

program
  .command('codegen')
  .description('Regenerate migrations/_generated.ts from the numbered migration files.')
  .action(() => {
    const project = findProject();
    const { changed, migrations } = writeGenerated(project);
    const where = relative(project.root, project.migrationsDir);
    p.log.success(`${changed ? 'Wrote' : 'Up to date:'} ${where}/_generated.ts (${migrations.length} migration${migrations.length === 1 ? '' : 's'})`);
  });

program
  .command('bundle')
  .description('Write the push requests a release image applies (run by the image build).')
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
  .description('Build the release image, tagged <package name>:<package version>.')
  .option('-t, --tag <tag>', 'the image tag (default from package.json)')
  .option('--oneshot', 'build the one-shot image (releases to a separate backend) instead')
  .action((options: { tag?: string; oneshot?: boolean }) => {
    const project = findProject();
    const tag = options.tag ?? appImageName(project, options.oneshot ? '-release' : '');
    p.log.step(`Building ${tag}`);
    build(project, { tag, oneshot: options.oneshot });
    p.log.success(`Built ${tag}`);
  });

program
  .command('test-upgrade')
  .description('Check that the new release upgrades data from a previous one: starts --from, then --to on the same volume.')
  .requiredOption('--from <image>', 'the release users run today, e.g. my-app:1.3.0')
  .option('--to <image>', 'the new release (default: build this project first)')
  .option('--seed <function>', 'a function to run on --from to create data, e.g. testing:seed')
  .option('--check <function>', 'a function to run on --to afterwards; it should throw if the data is wrong')
  .option('--timeout <seconds>', 'how long each release may take to become ready', '600')
  .action(async (options: { from: string; to?: string; seed?: string; check?: string; timeout: string }) => {
    const project = findProject();
    let to = options.to;
    if (!to) {
      to = appImageName(project);
      p.log.step(`Building ${to}`);
      build(project, { tag: to });
    }
    const spinner = p.spinner();
    let current: string | undefined;
    try {
      await testUpgrade(
        { from: options.from, to, seed: options.seed, check: options.check, timeoutMs: Number(options.timeout) * 1000 },
        {
          step: (message) => {
            if (current) spinner.stop(current);
            spinner.start(message);
            current = message;
          },
          log: (line) => spinner.message(`${current}: ${line}`),
        },
      );
    } catch (err) {
      spinner.error(current ?? 'Failed');
      throw err;
    }
    spinner.stop(current);
    p.log.success(`${options.from} upgrades to ${to}`);
  });

async function runRelease(project: Project, target: ReleaseTarget) {
  const spinner = p.spinner();
  let current: string | undefined;
  let result;
  try {
    result = await release(project, target, {
      step: (message) => {
        if (current) spinner.stop(current);
        spinner.start(message);
        current = message;
      },
      progress: (s) => {
        current = `Ran migrations: ${s.message ?? s.state}`;
        spinner.message(`Running migrations: ${s.message ?? s.state}`);
      },
    });
  } catch (err) {
    spinner.error(current ?? 'Failed');
    throw err;
  }
  if (result.state !== 'done') {
    spinner.error(result.message ?? 'Migrations failed');
    process.exit(1);
  }
  spinner.stop(current);
  p.log.success('Released: code deployed, data matches the schema.');
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
