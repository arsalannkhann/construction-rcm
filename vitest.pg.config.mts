import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.mts';

/** The same suite, against a real PostgreSQL server. See tests/pg/global-setup.ts. */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      globalSetup: ['tests/pg/global-setup.ts'],
      include: ['tests/**/*.test.ts'],
    },
  }),
);
