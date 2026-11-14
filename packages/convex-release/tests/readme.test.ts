import { readFileSync } from 'node:fs';

import { expect, test } from 'vite-plus/test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test("the README's backend tag is the one images/Dockerfile pins", () => {
  const pinned = /^ARG BACKEND_IMAGE=(\S+)$/m.exec(read('../../../images/Dockerfile'))![1];
  const inReadme = [...read('../README.md').matchAll(/ghcr\.io\/convex\/convex-backend:\S+/g)].map((m) => m[0]);
  expect(inReadme.length).toBeGreaterThan(0);
  for (const image of inReadme) expect(image).toBe(pinned);
});
