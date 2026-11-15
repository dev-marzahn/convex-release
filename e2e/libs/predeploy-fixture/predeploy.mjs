// The fixture library's predeploy check: refuses a release while a flag
// document exists in its component. Node built-ins only, as convex-release
// requires of a check module.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const protocol = 1;

export async function collect({ projectRoot }) {
  const { name } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  return { app: name };
}

export async function check({ facts, query, log }) {
  log(`checking ${facts.app}`);
  let reason;
  try {
    reason = await query({ componentPath: 'predeployFixture', path: 'flags:isBlocked' });
  } catch (err) {
    // The release that first adds this library: nothing can be blocked yet.
    if (err.code === 'COMPONENT_NOT_DEPLOYED') return { ok: true };
    throw err;
  }
  return reason === null ? { ok: true } : { ok: false, message: 'blocked by a flag', details: [reason] };
}
