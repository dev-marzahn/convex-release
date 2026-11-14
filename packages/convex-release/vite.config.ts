import { defineConfig } from 'vite-plus';

// Lint and format settings live in the repo root's vite.config.ts.
export default defineConfig({
  pack: [
    {
      entry: ['src/index.ts', 'src/seed.ts', 'src/cli.ts'],
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
