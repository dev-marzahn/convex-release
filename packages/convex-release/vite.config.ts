import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    // src/index.ts: the library apps import (defineMigration, release wiring).
    // src/cli.ts: the `convex-release` binary.
    entry: ['src/index.ts', 'src/cli.ts'],
    dts: {
      generator: 'tsgo',
    },
    exports: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
