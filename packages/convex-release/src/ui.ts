// Terminal output that also reads well in CI logs.
import { appendFileSync } from 'node:fs';

import * as p from '@clack/prompts';

import type { MigrationRow } from './status.ts';

/** In a terminal: spinners. Elsewhere (CI, pipes): one line per change. */
export const interactive = Boolean(process.stdout.isTTY) && !process.env.CI;

export interface Progress {
  /** Ends the current step (shown as done) and starts the next. */
  step: (message: string) => void;
  /** Updates the current step's detail. */
  update: (message: string) => void;
  /** Ends the current step as done, with its final text. */
  done: (message?: string) => void;
  /** Ends the current step as failed. */
  fail: (message?: string) => void;
}

export function progress(): Progress {
  let current: string | undefined;
  let last: string | undefined;
  if (interactive) {
    const spinner = p.spinner();
    return {
      step: (message) => {
        if (current) spinner.stop(last ?? current);
        spinner.start(message);
        current = message;
        last = undefined;
      },
      update: (message) => {
        last = message;
        spinner.message(message);
      },
      done: (message) => spinner.stop(message ?? last ?? current),
      fail: (message) => spinner.error(message ?? current ?? 'Failed'),
    };
  }
  const line = (text: string) => console.log(text);
  return {
    step: (message) => {
      current = message;
      line(`• ${message}`);
    },
    update: (message) => {
      if (message === last) return;
      last = message;
      line(`  ${message}`);
    },
    done: (message) => {
      if (message) line(`✔ ${message}`);
    },
    fail: (message) => line(`✖ ${message ?? current ?? 'Failed'}`),
  };
}

/** Appends Markdown to the GitHub Actions job summary, when there is one. */
export function jobSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

export function migrationsMarkdown(title: string, rows: MigrationRow[]): string {
  const icon: Record<string, string> = { done: '✅', running: '⏳', pending: '⚪', failed: '❌', canceled: '❌' };
  const lines = rows.map((r) => {
    const note = r.unknown ? 'not in this checkout' : (r.error?.split('\n')[0] ?? '');
    return `| ${icon[r.state]} | \`${r.name.replace(/^migrations\//, '')}\` | ${r.state} | ${r.processed} | ${note.replace(/\|/g, '\\|')} |`;
  });
  return [`### ${title}`, '', '| | Migration | State | Documents | |', '| --- | --- | --- | --- | --- |', ...lines, ''].join('\n');
}

/** Fails when a prompt would be needed but nobody can answer it. */
export function requireAnswer(value: string | undefined, flag: string): string | undefined {
  if (value !== undefined || interactive) return value;
  throw new Error(`Missing ${flag}: there's no terminal to ask in.`);
}
