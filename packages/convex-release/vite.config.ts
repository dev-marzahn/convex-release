import { defineConfig } from 'vite-plus';

// Lint and format settings live in the repo root's vite.config.ts.
export default defineConfig({
  pack: [
    {
      // src/index.ts: the library apps import (via the generated migrations file).
      // src/cli.ts: the `convex-release` binary.
      entry: ['src/index.ts', 'src/cli.ts'],
      dts: { generator: 'tsgo' },
      exports: true,
    },
    {
      // The release images' entrypoint: standalone, Node built-ins only.
      entry: { 'image/entrypoint': 'src/image/entrypoint.ts' },
      dts: false,
      clean: false,
    },
  ],
});
