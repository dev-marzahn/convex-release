import { defineConfig } from 'vite-plus';

// Generated code keeps the style of whatever generates it.
const generated = ['**/_generated/**', '**/migrations/_generated.ts'];

export default defineConfig({
  fmt: {
    printWidth: 160,
    singleQuote: true,
    semi: true,
    trailingComma: 'all',
    sortImports: true,
    ignorePatterns: generated,
  },
  lint: {
    ignorePatterns: generated,
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
