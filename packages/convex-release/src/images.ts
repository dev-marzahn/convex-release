// The published base images, at the version of this package. An app built
// with convex-release x.y.z uses the images of x.y.z, so the build-time bundle
// and the entrypoint always come from the same release.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pkg from '../package.json' with { type: 'json' };
import type { Project } from './project.ts';

/** The default: the Convex backend plus the release entrypoint. */
export const IMAGE = `ghcr.io/dev-marzahn/convex-release:${pkg.version}`;
/** Releases to a separate backend and exits. */
export const ONESHOT_IMAGE = `ghcr.io/dev-marzahn/convex-release-oneshot:${pkg.version}`;

/** `<name>:<version>` from the app's package.json, as Docker accepts it. */
export function appImageName(project: Project, suffix = ''): string {
  const manifest = JSON.parse(readFileSync(join(project.root, 'package.json'), 'utf8')) as { name?: string; version?: string };
  const name = (manifest.name ?? 'app')
    .replace(/^@[^/]+\//, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return `${name}${suffix}:${manifest.version ?? 'latest'}`;
}
