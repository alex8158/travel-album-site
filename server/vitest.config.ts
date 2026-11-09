import { defineConfig } from 'vitest/config';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Test runs never touch the application's server/data (docs/agent/known-issues.md 12b).
// One fresh directory per test run (this process), shared by its single fork worker:
// the SQLite database, the temp dir and a JWT secret live there. Values that are
// already set in the environment are kept, so an isolated copy can point elsewhere.
const testRoot = path.join(os.tmpdir(), `travel-album-vitest-${process.pid}`);
fs.rmSync(testRoot, { recursive: true, force: true });
fs.mkdirSync(testRoot, { recursive: true });
const testEnv = {
  TRAVEL_ALBUM_TEST_DB_PATH: process.env.TRAVEL_ALBUM_TEST_DB_PATH || path.join(testRoot, 'data', 'travel-album.db'),
  TEMP_DIR: process.env.TEMP_DIR || path.join(testRoot, 'tmp'),
  JWT_SECRET: process.env.JWT_SECRET || `vitest-${process.pid}-${Date.now()}`,
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: testEnv,
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
