import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Tests must be deterministic and offline: the rule parser is the reference.
    // The optional LLM end-to-end suite opts back in via `tests/llm.e2e.test.ts`.
    env: {
      LLM_DISABLED: '1',
    },
    // `node:sqlite` is a real Node builtin, not an npm package — keep Vite from
    // trying to resolve/bundle it.
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
  optimizeDeps: {
    exclude: ['node:sqlite'],
  },
});
